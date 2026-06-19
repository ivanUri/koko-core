

const { createServer } = require("http");
const { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync } = require("fs");
const { extname, join, resolve } = require("path");
const { spawn } = require("child_process");
const { tmpdir } = require("os");

const root = resolve(__dirname, "../..");
const fixturesRoot = __dirname;

const chrome =
    process.env.CHROME_BIN ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const host = "127.0.0.1";
const only = process.argv[2];

const STARTUP_TIMEOUT_MS = 5000;
const SCENARIO_TIMEOUT_MS = 5000;
const SHUTDOWN_TIMEOUT_MS = 2000;
const CDP_TIMEOUT_MS = 2000;

const children = new Set();

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout ${label} `)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function mime(file) {
    switch (extname(file)) {
        case ".html": return "text/html";
        case ".js": return "text/javascript";
        case ".json": return "application/json";
        default: return "application/octet-stream";
    }
}

function listen(server, port = 0) {
    return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server.address().port));
    });
}

function serveFixture(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const parts = url.pathname.split("/").filter(Boolean);

    const scenario = parts.shift();
    const rel = parts.length ? parts.join("/") : "index.html";

    const file = resolve(fixturesRoot, scenario || "", rel);

    if (!file.startsWith(resolve(fixturesRoot)) || !existsSync(file)) {
        res.writeHead(404);
        res.end("not found");
        return;
    }

    res.writeHead(200, {
        "content-type": mime(file),
    });

    res.end(readFileSync(file));
}

async function reservePort() {
    const server = createServer((_, res) => {
        res.writeHead(404);
        res.end();
    });

    const port = await listen(server);

    await new Promise((resolve) => server.close(resolve));

    return port;
}

function spawnChrome(cdpPort) {
    const profileDir = mkdtempSync(join(tmpdir(), "velora-chrome-"));

    const child = spawn(
        chrome,
        [
            "--headless=new",
            "--disable-gpu",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
            "--remote-debugging-port=" + cdpPort,
            "--user-data-dir=" + profileDir,
            "about:blank",
        ],
        {
            stdio: ["ignore", "ignore", "pipe"],
        },
    );

    child.__profileDir = profileDir;

    children.add(child);

    child.stderr.on("data", (data) => {
        process.stderr.write(data);
    });

    child.once("exit", () => {
        children.delete(child);

        try {
            rmSync(profileDir, { recursive: true, force: true });
        } catch (_) { }
    });

    return child;
}

async function terminateProcess(child) {
    if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) {
        return "exited";
    }

    child.kill("SIGTERM");

    const exited = await Promise.race([
        new Promise((resolve) => child.once("exit", () => resolve(true))),
        delay(SHUTDOWN_TIMEOUT_MS).then(() => false),
    ]);

    if (exited) return "sigterm";

    child.kill("SIGKILL");

    await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        delay(1000),
    ]);

    return "sigkill";
}

async function cleanupChildren() {
    for (const child of Array.from(children)) {
        await terminateProcess(child).catch(() => { });
    }
}

function send(ws, method, params = {}, sessionId, timeoutMs = CDP_TIMEOUT_MS) {
    const id = (send.id = (send.id || 0) + 1);

    const payload = { id, method, params };

    if (sessionId) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.removeEventListener("message", onMessage);
            reject(new Error(`timeout ${method}`));
        }, timeoutMs);

        function onMessage(event) {
            const msg = JSON.parse(event.data);

            if (msg.id !== id) return;

            clearTimeout(timer);

            ws.removeEventListener("message", onMessage);

            msg.error
                ? reject(new Error(`${method}: ${msg.error.message}`))
                : resolve(msg.result || {});
        }

        ws.addEventListener("message", onMessage);

        ws.send(JSON.stringify(payload));
    });
}

async function evaluate(ws, sessionId, expression) {
    try {
        const result = await send(
            ws,
            "Runtime.evaluate",
            {
                expression,
                awaitPromise: true,
                returnByValue: true,
            },
            sessionId,
        );

        return {
            ok: true,
            value: result.result && result.result.value,
        };
    } catch (err) {
        return {
            ok: false,
            error: err.message,
        };
    }
}

async function waitDone(ws, sessionId) {
    const start = Date.now();

    let lastError = null;

    while (Date.now() - start < SCENARIO_TIMEOUT_MS) {
        const result = await evaluate(
            ws,
            sessionId,
            "!!(window.TEST_RESULT && window.TEST_RESULT.done)"
        );

        if (result.ok && result.value) {
            return { done: true };
        }

        if (!result.ok) {
            lastError = result.error;
        }

        await delay(100);
    }

    return {
        done: false,
        error: lastError || "scenario timeout",
    };
}

async function waitForChrome(cdpPort) {
    const start = Date.now();

    while (Date.now() - start < STARTUP_TIMEOUT_MS) {
        try {
            const response = await fetch(`http://${host}:${cdpPort}/json/version`);

            if (response.ok) {
                return response.json();
            }
        } catch (_) { }

        await delay(100);
    }

    throw new Error("chrome CDP server did not start");
}

function scenarioNames() {
    if (only) return [only];

    return readdirSync(fixturesRoot, { withFileTypes: true })
        .filter(
            (entry) =>
                entry.isDirectory() &&
                existsSync(join(fixturesRoot, entry.name, "expected.json"))
        )
        .map((entry) => entry.name)
        .sort();
}

async function runScenarioInProcess(httpPort, name) {
    const expected = JSON.parse(
        readFileSync(join(fixturesRoot, name, "expected.json"), "utf8")
    );

    const cdpPort = await reservePort();

    const child = spawnChrome(cdpPort);

    let ws;
    let targetId;

    try {
        const version = await withTimeout(
            waitForChrome(cdpPort),
            STARTUP_TIMEOUT_MS,
            "startup"
        );

        ws = new WebSocket(version.webSocketDebuggerUrl);

        await withTimeout(
            new Promise((resolve, reject) => {
                ws.addEventListener("open", resolve, { once: true });
                ws.addEventListener("error", reject, { once: true });
            }),
            STARTUP_TIMEOUT_MS,
            "websocket open"
        );

        const body = async () => {
            ({ targetId } = await send(ws, "Target.createTarget", {
                url: "about:blank",
            }));

            const { sessionId } = await send(
                ws,
                "Target.attachToTarget",
                {
                    targetId,
                    flatten: true,
                }
            );

            await send(ws, "Page.enable", {}, sessionId).catch(() => { });
            await send(ws, "Runtime.enable", {}, sessionId).catch(() => { });

            await send(
                ws,
                "Page.navigate",
                {
                    url: `http://${host}:${httpPort}/${name}/index.html`,
                },
                sessionId
            );

            const doneInfo = await waitDone(ws, sessionId);

            const logsResult = await evaluate(
                ws,
                sessionId,
                "JSON.stringify(window.TEST_LOGS || [])"
            );

            const testResult = await evaluate(
                ws,
                sessionId,
                "JSON.stringify(window.TEST_RESULT || null)"
            );

            const logs = logsResult.value || "[]";
            const result = testResult.value || "null";

            const entries = JSON.parse(logs);

            const missing = (expected.must_contain || []).filter(
                (item) => !entries.includes(item)
            );

            const forbidden = (expected.must_not_contain || []).filter(
                (item) => entries.includes(item)
            );

            const ok =
                doneInfo.done &&
                missing.length === 0 &&
                forbidden.length === 0;

            return {
                status: ok ? "PASS" : "FAIL",
                ok,
                doneInfo,
                logs,
                result,
                missing,
                forbidden,
            };
        };

        return await withTimeout(
            body(),
            SCENARIO_TIMEOUT_MS + 1500,
            "scenario"
        );
    } catch (err) {
        return {
            status: "ERROR",
            ok: false,
            error: err.message,
        };
    } finally {
        if (ws) ws.close();

        if (targetId) {
            try {
                await send(ws, "Target.closeTarget", { targetId }, undefined, 500);
            } catch (_) { }
        }

        await terminateProcess(child).catch(() => { });
    }
}

function printScenario(name, report) {
    console.log(`\n${report.status} ${name}`);

    if (report.error) {
        console.log(`  error: ${report.error}`);
        return;
    }

    console.log(`  done: ${report.doneInfo.done}`);
    console.log(`  TEST_RESULT: ${report.result}`);
    console.log(`  TEST_LOGS: ${report.logs}`);

    if (report.doneInfo.error) {
        console.log(`  waitDone: ${report.doneInfo.error}`);
    }

    if (report.missing.length) {
        console.log(`  missing: ${JSON.stringify(report.missing)}`);
    }

    if (report.forbidden.length) {
        console.log(`  forbidden: ${JSON.stringify(report.forbidden)}`);
    }
}

async function main() {
    if (!existsSync(chrome)) {
        throw new Error(`chrome binary not found: ${chrome}`);
    }

    const httpServer = createServer(serveFixture);

    const httpPort = await listen(httpServer);

    const names = scenarioNames();

    const counts = {
        PASS: 0,
        FAIL: 0,
        ERROR: 0,
    };

    try {
        for (const name of names) {
            const report = await runScenarioInProcess(httpPort, name);

            counts[report.status] = (counts[report.status] || 0) + 1;

            printScenario(name, report);
        }
    } finally {
        httpServer.close();

        await cleanupChildren();
    }

    console.log(
        `\nSUMMARY ${counts.PASS}/${names.length} passed`
    );

    process.exitCode =
        counts.PASS === names.length ? 0 : 1;
}

process.on("exit", () => {
    for (const child of Array.from(children)) {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
        }
    }
});

main().catch(async (err) => {
    console.error(err);

    await cleanupChildren();

    process.exit(1);
});

