#!/usr/bin/env node

const { createServer } = require("http");
const { existsSync, readFileSync, readdirSync } = require("fs");
const { extname, join, resolve } = require("path");
const { spawn } = require("child_process");

const root = resolve(__dirname, "../..");
const fixturesRoot = __dirname;
const velora = join(root, "zig-out/bin/velora");
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
        timer = setTimeout(() => reject(new Error(`timeout ${label}`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function mime(file) {
    switch (extname(file)) {
        case ".html": return "text/html";
        case ".js": return "text/javascript";
        case ".json": return "application/json";
        case ".txt": return "text/plain";
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

    res.writeHead(200, { "content-type": mime(file) });
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

function spawnVelora(cdpPort) {
    const child = spawn(
        velora,
        ["serve", "--host", host, "--port", String(cdpPort), "--log-level", "error"],
        { stdio: ["ignore", "ignore", "pipe"] },
    );
    children.add(child);
    child.stderr.on("data", (data) => process.stderr.write(data));
    child.once("exit", () => children.delete(child));
    return child;
}

async function terminateProcess(child) {
    if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) return "exited";

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
        await terminateProcess(child).catch(() => {});
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
            msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result || {});
        }

        ws.addEventListener("message", onMessage);
        ws.send(JSON.stringify(payload));
    });
}

async function evaluate(ws, sessionId, expression) {
    try {
        const result = await send(ws, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
        return { ok: true, value: result.result && result.result.value };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

async function waitDone(ws, sessionId) {
    const start = Date.now();
    let lastError = null;

    while (Date.now() - start < SCENARIO_TIMEOUT_MS) {
        const result = await evaluate(ws, sessionId, "!!(window.TEST_RESULT && window.TEST_RESULT.done)");
        if (result.ok && result.value) return { done: true };
        if (!result.ok) lastError = result.error;
        await delay(100);
    }

    return { done: false, error: lastError || "scenario timeout" };
}

async function waitForVelora(cdpPort) {
    const start = Date.now();
    while (Date.now() - start < STARTUP_TIMEOUT_MS) {
        try {
            const response = await fetch(`http://${host}:${cdpPort}/json/version`);
            if (response.ok) return response.json();
        } catch (_) {}
        await delay(100);
    }
    throw new Error("velora CDP server did not start");
}

function scenarioNames() {
    if (only) return [only];
    return readdirSync(fixturesRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(fixturesRoot, entry.name, "expected.json")))
        .map((entry) => entry.name)
        .sort();
}

function classifyHarnessError(error) {
    if (/timeout Runtime\.evaluate|timeout Target\.createTarget|timeout Target\.attachToTarget|timeout Page\.navigate/.test(error)) {
        return "POISONED_RUNTIME";
    }
    if (/timeout/.test(error)) return "TIMEOUT";
    return "HARNESS_ERROR";
}

async function runScenarioInProcess(httpPort, name) {
    const expected = JSON.parse(readFileSync(join(fixturesRoot, name, "expected.json"), "utf8"));
    const cdpPort = await reservePort();
    const child = spawnVelora(cdpPort);
    let ws;
    let targetId;
    let shutdown = "not-started";

    try {
        const version = await withTimeout(waitForVelora(cdpPort), STARTUP_TIMEOUT_MS, "startup");
        ws = new WebSocket(version.webSocketDebuggerUrl);
        await withTimeout(new Promise((resolve, reject) => {
            ws.addEventListener("open", resolve, { once: true });
            ws.addEventListener("error", reject, { once: true });
        }), STARTUP_TIMEOUT_MS, "websocket open");

        const body = async () => {
            ({ targetId } = await send(ws, "Target.createTarget", { url: "about:blank" }));
            const { sessionId } = await send(ws, "Target.attachToTarget", { targetId, flatten: true });
            const cdpEvents = [];
            const contextIds = new Set();
            const frameNavigateCounts = new Map();
            const eventMethods = new Set([
                "Page.frameNavigated",
                "Page.frameStartedNavigating",
                "Page.frameStartedLoading",
                "Page.frameStoppedLoading",
                "Runtime.executionContextsCleared",
                "Runtime.executionContextCreated",
                "Runtime.executionContextDestroyed",
                "DOM.documentUpdated",
            ]);
            const eventListener = (event) => {
                const msg = JSON.parse(event.data);
                if (!msg.method || !eventMethods.has(msg.method)) return;
                const entry = { index: cdpEvents.length, method: msg.method };
                const params = msg.params || {};
                if (params.frame) {
                    entry.frameId = params.frame.id;
                    entry.loaderId = params.frame.loaderId;
                    entry.url = params.frame.url;
                    frameNavigateCounts.set(entry.frameId + ":" + entry.loaderId, (frameNavigateCounts.get(entry.frameId + ":" + entry.loaderId) || 0) + 1);
                }
                if (params.context) {
                    entry.contextId = params.context.id;
                    contextIds.add(params.context.id);
                    try { entry.auxData = JSON.parse(params.context.auxData || "{}"); } catch (_) {}
                }
                cdpEvents.push(entry);
            };
            ws.addEventListener("message", eventListener);
            await send(ws, "Page.enable", {}, sessionId).catch(() => {});
            await send(ws, "Runtime.enable", {}, sessionId).catch(() => {});
            await send(ws, "DOM.enable", {}, sessionId).catch(() => {});
            const scriptSource = "window.__NEW_DOCUMENT_ORDER__=(window.__NEW_DOCUMENT_ORDER__||[]); window.__NEW_DOCUMENT_ORDER__.push({url: location.href, objectReady: typeof Object === 'function', functionToStringReady: !!(Function && Function.prototype && Function.prototype.toString), documentReady: !!document});";
            await send(ws, "Page.addScriptToEvaluateOnNewDocument", { source: scriptSource }, sessionId).catch(() => {});
            await send(ws, "Page.navigate", { url: `http://${host}:${httpPort}/${name}/index.html` }, sessionId);

            const doneInfo = await waitDone(ws, sessionId);
            ws.removeEventListener("message", eventListener);
            const logsResult = await evaluate(ws, sessionId, "JSON.stringify(window.TEST_LOGS || [])");
            const testResult = await evaluate(ws, sessionId, "JSON.stringify(window.TEST_RESULT || null)");
            const injectedResult = await evaluate(ws, sessionId, "JSON.stringify(window.__NEW_DOCUMENT_ORDER__ || [])");
            if (!logsResult.ok || !testResult.ok) {
                const err = logsResult.error || testResult.error;
                return { status: classifyHarnessError(err), ok: false, doneInfo, logsResult, testResult, logs: "[]", result: "null", missing: expected.must_contain || [], forbidden: [], runtime_poisoned: true };
            }

            const logs = logsResult.value || "[]";
            const result = testResult.value || "null";
            const injected = injectedResult.value || "[]";
            const entries = JSON.parse(logs);
            const missing = (expected.must_contain || []).filter((item) => !entries.includes(item));
            const forbidden = (expected.must_not_contain || []).filter((item) => entries.includes(item));
            const cdpMissing = (expected.cdp_must_contain || []).filter((method) => !cdpEvents.some((entry) => entry.method === method));
            const duplicateFrameNavigated = Array.from(frameNavigateCounts.values()).some((count) => count > 1);
            const contextBeforeFrame = cdpEvents.findIndex((entry) => entry.method === "Runtime.executionContextCreated") >= 0 &&
                cdpEvents.findIndex((entry) => entry.method === "Page.frameNavigated") >= 0 &&
                cdpEvents.findIndex((entry) => entry.method === "Runtime.executionContextCreated") < cdpEvents.findIndex((entry) => entry.method === "Page.frameNavigated");
            const invariantErrors = [];
            if ((expected.assert_no_duplicate_frame_navigated || expected.assert_no_duplicate_lifecycle_events) && duplicateFrameNavigated) invariantErrors.push("duplicate-frameNavigated");
            if (expected.assert_context_before_frame_navigated && !contextBeforeFrame) invariantErrors.push("context-created-not-before-frameNavigated");
            if (expected.assert_injected_script_stable) {
                const injectedEntries = JSON.parse(injected);
                if (!injectedEntries.length || injectedEntries.some((entry) => !entry.objectReady || !entry.functionToStringReady || !entry.documentReady)) invariantErrors.push("injected-script-unstable");
            }
            const ok = doneInfo.done && missing.length === 0 && forbidden.length === 0 && cdpMissing.length === 0 && invariantErrors.length === 0;
            return { status: ok ? "PASS" : "FAIL", ok, doneInfo, logs, result, injected, cdpEvents: JSON.stringify(cdpEvents), contextIds: JSON.stringify(Array.from(contextIds)), missing, forbidden, cdpMissing, invariantErrors, logsResult, testResult, runtime_poisoned: false };
        };

        const report = await withTimeout(body(), SCENARIO_TIMEOUT_MS + 1500, "scenario");
        if (targetId) await send(ws, "Target.closeTarget", { targetId }, undefined, 500).catch(() => {});
        return report;
    } catch (err) {
        return { status: classifyHarnessError(err.message), ok: false, error: err.message, runtime_poisoned: classifyHarnessError(err.message) === "POISONED_RUNTIME" };
    } finally {
        if (ws) ws.close();
        shutdown = await terminateProcess(child).catch((err) => `shutdown-error:${err.message}`);
        child.__shutdown = shutdown;
    }
}

function printScenario(name, report) {
    console.log(`\n${report.status} ${name}`);
    if (report.error) {
        console.log(`  error: ${report.error}`);
        if (report.runtime_poisoned) console.log("  runtime_poisoned: true");
        return;
    }

    console.log(`  done: ${report.doneInfo.done}`);
    console.log(`  TEST_RESULT: ${report.result}`);
    console.log(`  TEST_LOGS: ${report.logs}`);
    if (report.runtime_poisoned) console.log("  runtime_poisoned: true");
    if (!report.logsResult.ok) console.log(`  logs: ${report.logsResult.error}`);
    if (!report.testResult.ok) console.log(`  result: ${report.testResult.error}`);
    if (report.doneInfo.error) console.log(`  waitDone: ${report.doneInfo.error}`);
    if (report.injected) console.log(`  NEW_DOCUMENT: ${report.injected}`);
    if (report.cdpEvents) console.log(`  CDP_EVENTS: ${report.cdpEvents}`);
    if (report.contextIds) console.log(`  CONTEXT_IDS: ${report.contextIds}`);
    if (report.missing.length) console.log(`  missing: ${JSON.stringify(report.missing)}`);
    if (report.forbidden.length) console.log(`  forbidden: ${JSON.stringify(report.forbidden)}`);
    if (report.cdpMissing && report.cdpMissing.length) console.log(`  cdpMissing: ${JSON.stringify(report.cdpMissing)}`);
    if (report.invariantErrors && report.invariantErrors.length) console.log(`  invariantErrors: ${JSON.stringify(report.invariantErrors)}`);
}

async function main() {
    if (!existsSync(velora)) throw new Error(`velora binary not found: ${velora}`);

    const httpServer = createServer(serveFixture);
    const httpPort = await listen(httpServer);
    const names = scenarioNames();
    const counts = { PASS: 0, FAIL: 0, TIMEOUT: 0, POISONED_RUNTIME: 0, HARNESS_ERROR: 0 };

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

    console.log(`\nSUMMARY ${counts.PASS}/${names.length} passed`);
    console.log(`STATUS PASS=${counts.PASS} FAIL=${counts.FAIL} TIMEOUT=${counts.TIMEOUT} POISONED_RUNTIME=${counts.POISONED_RUNTIME} HARNESS_ERROR=${counts.HARNESS_ERROR}`);
    process.exitCode = counts.PASS === names.length ? 0 : 1;
}

process.on("exit", () => {
    for (const child of Array.from(children)) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
});

main().catch(async (err) => {
    console.error(err);
    await cleanupChildren();
    process.exit(1);
});
