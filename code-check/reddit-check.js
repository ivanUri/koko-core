#!/usr/bin/env node
// Check that a page loads through Velora CDP and exposes basic page content.
// Usage:
//   node code-check/example-com-check.js
//   node code-check/example-com-check.js --url https://example.com/

const { spawn } = require("node:child_process");
const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const tmpDir = resolve(repoRoot, "code-check/tmp");
const outputDir = resolve(tmpDir, "output");
const logDir = resolve(tmpDir, "logs");

const defaults = {
    url: "https://www.reddit.com/",
    host: "127.0.0.1",
    waitMs: 20000,
    serverTimeoutMs: 15000,
    commandTimeoutMs: 15000,
    navigationTimeoutMs: 20000,
    output: resolve(outputDir, "example-com-check.html"),
    report: resolve(outputDir, "example-com-check.report.json"),
    log: resolve(logDir, "example-com-check.log"),
    httpTimeoutMs: 30000,
    logLevel: "debug",
    logFormat: "pretty",
};

function usage() {
    return `Usage: node code-check/example-com-check.js [options]

Options:
  --url <url>          URL to open (default: ${defaults.url})
  --wait-ms <ms>       Extra wait after navigation (default: ${defaults.waitMs})
  --timeout <ms>       Navigation timeout (default: ${defaults.navigationTimeoutMs})
  --output <path>      HTML output file (default: ${defaults.output})
  --report <path>      JSON report file (default: ${defaults.report})
  --log <path>         Velora log file (default: ${defaults.log})
  --http-timeout <ms>  Velora HTTP timeout (default: ${defaults.httpTimeoutMs})
  --log-level <level>  Velora log level (default: ${defaults.logLevel})
  --help               Show this help
`;
}

function parseArgs(argv) {
    const options = { ...defaults };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
            i += 1;
            return argv[i];
        };

        switch (arg) {
            case "--url":
                options.url = next();
                break;
            case "--wait-ms":
                options.waitMs = Number(next());
                break;
            case "--timeout":
                options.navigationTimeoutMs = Number(next());
                break;
            case "--output":
                options.output = resolve(next());
                break;
            case "--report":
                options.report = resolve(next());
                break;
            case "--log":
                options.log = resolve(next());
                break;
            case "--http-timeout":
                options.httpTimeoutMs = Number(next());
                break;
            case "--log-level":
                options.logLevel = next();
                break;
            case "--help":
            case "-h":
                options.help = true;
                break;
            default:
                throw new Error(`Unknown option: ${arg}`);
        }
    }

    for (const key of ["waitMs", "serverTimeoutMs", "commandTimeoutMs", "navigationTimeoutMs", "httpTimeoutMs"]) {
        if (!Number.isFinite(options[key]) || options[key] < 0) {
            throw new Error(`Invalid numeric option ${key}: ${options[key]}`);
        }
    }
    return options;
}

function appendSection(logPath, title, content) {
    appendFileSync(logPath, `\n--- ${title} ---\n`);
    appendFileSync(logPath, content || "");
}

function delay(ms) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function getFreePort(host) {
    return new Promise((resolvePromise, reject) => {
        const server = createServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, host, () => {
            const { port } = server.address();
            server.close(() => resolvePromise(port));
        });
    });
}

async function connectCDP(cdpEndpoint, options) {
    const versionRes = await fetch(`${cdpEndpoint}/json/version`);
    if (!versionRes.ok) throw new Error(`Unable to read CDP version: HTTP ${versionRes.status}`);

    const { webSocketDebuggerUrl } = await versionRes.json();
    if (!webSocketDebuggerUrl) throw new Error("CDP version response does not include webSocketDebuggerUrl");

    const ws = new WebSocket(webSocketDebuggerUrl);
    const callbacks = new Map();
    const listeners = new Map();
    let nextId = 1;
    let closed = false;

    function emit(method, message) {
        for (const listener of listeners.get(method) || []) listener(message);
        for (const listener of listeners.get("*") || []) listener(message);
    }

    function rejectPending(err) {
        for (const [id, callback] of callbacks) {
            clearTimeout(callback.timer);
            callback.reject(err);
            callbacks.delete(id);
        }
    }

    ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id != null && callbacks.has(message.id)) {
            const callback = callbacks.get(message.id);
            callbacks.delete(message.id);
            clearTimeout(callback.timer);
            if (message.error) {
                callback.reject(new Error(`${callback.method}: ${message.error.message} (${message.error.code})`));
            } else {
                callback.resolve(message.result || {});
            }
            return;
        }
        if (message.method) emit(message.method, message);
    });

    await new Promise((resolvePromise, reject) => {
        ws.addEventListener("open", resolvePromise, { once: true });
        ws.addEventListener("error", reject, { once: true });
    });

    ws.addEventListener("close", () => {
        closed = true;
        rejectPending(new Error("CDP websocket closed"));
    });

    return {
        send(method, params = {}, sessionId, timeoutMs = options.commandTimeoutMs) {
            if (closed || ws.readyState !== WebSocket.OPEN) {
                return Promise.reject(new Error(`Cannot send ${method}: CDP websocket is not open`));
            }
            const id = nextId++;
            const payload = { id, method, params };
            if (sessionId) payload.sessionId = sessionId;

            return new Promise((resolvePromise, reject) => {
                const timer = timeoutMs
                    ? setTimeout(() => {
                        callbacks.delete(id);
                        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
                    }, timeoutMs)
                    : null;
                callbacks.set(id, { method, resolve: resolvePromise, reject, timer });
                ws.send(JSON.stringify(payload));
            });
        },
        on(method, listener) {
            const list = listeners.get(method) || [];
            list.push(listener);
            listeners.set(method, list);
            return () => listeners.set(method, (listeners.get(method) || []).filter((item) => item !== listener));
        },
        waitFor(method, predicate = () => true, timeoutMs = options.commandTimeoutMs) {
            return new Promise((resolvePromise, reject) => {
                const timer = timeoutMs ? setTimeout(() => {
                    off();
                    reject(new Error(`${method} timed out after ${timeoutMs}ms`));
                }, timeoutMs) : null;
                const off = this.on(method, (message) => {
                    if (!predicate(message)) return;
                    if (timer) clearTimeout(timer);
                    off();
                    resolvePromise(message);
                });
            });
        },
        close() {
            closed = true;
            rejectPending(new Error("CDP client closed"));
            ws.close();
        },
    };
}

async function createPageSession(cdp) {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    return { targetId, sessionId };
}

async function evaluate(cdp, sessionId, expression, timeoutMs) {
    const result = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
    }, sessionId, timeoutMs);
    if (result.exceptionDetails) {
        throw new Error(`Runtime.evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result ? result.result.value : undefined;
}

async function getPageContent(cdp, sessionId, timeoutMs, pageUrl) {
    const html = await evaluate(cdp, sessionId, "document.documentElement.outerHTML", timeoutMs);
    const rawHtml = html || "";
    // Inject <base href="..."> so relative URLs resolve correctly when opening the HTML file locally.
    const baseTag = pageUrl ? `` : "";
    const htmlWithBase = baseTag
        ? rawHtml.replace(/(<head\b[^>]*>)/i, `$1${baseTag}`)
        : rawHtml;
    return `<!DOCTYPE html>\n${htmlWithBase}`;
}

async function navigate(cdp, sessionId, url, timeoutMs) {
    const loadEvent = cdp.waitFor("Page.loadEventFired", (msg) => !msg.sessionId || msg.sessionId === sessionId, timeoutMs);
    await cdp.send("Page.navigate", { url }, sessionId, timeoutMs);
    try {
        await loadEvent;
    } catch (err) {
        console.warn(`[navigate:warning] ${err.message}; continuing with current document`);
    }
}

async function waitForServer(url, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
        try {
            const res = await fetch(url);
            if (res.ok) return;
        } catch (_) {
            // Velora is still starting.
        }
        await delay(100);
    }
    throw new Error(`Timed out waiting for ${url}`);
}

function createPageTestRecorder() {
    const checks = [];

    const record = async (name, fn) => {
        try {
            checks.push({ name, passed: !!(await fn()) });
        } catch (err) {
            checks.push({
                name,
                passed: false,
                error: {
                    name: err?.name || "Error",
                    message: err?.message || String(err),
                },
            });
        }
    };

    return { checks, record };
}

async function testPage() {
    const { checks, record } = createPageTestRecorder();
    const text = document.body?.innerText || "";

    await record("page loaded successfully", () => document.readyState === "complete" || document.readyState === "interactive");
    await record("page has a title", () => !!document.title && document.title.trim().length > 0);
    await record("body has text content", () => text.trim().length > 0);
    await record("page has document element", () => !!document.documentElement);
    await record("page URL is available", () => !!location.href);

    return checks;
}

async function inspectPage() {
    const text = document.body?.innerText || "";
    const pageChecks = await testPage();
    const links = Array.from(document.querySelectorAll("a"))
        .map((link) => ({ text: link.textContent.trim(), href: link.href }))
        .filter((link) => link.text || link.href)
        .slice(0, 25);

    return {
        url: location.href,
        title: document.title || "",
        readyState: document.readyState,
        textLength: text.trim().length,
        bodyTextSample: text.trim().slice(0, 500),
        headingCount: document.querySelectorAll("h1,h2,h3").length,
        linkCount: document.links.length,
        hasTitle: !!document.title && document.title.trim().length > 0,
        hasH1: document.querySelectorAll("h1").length > 0,
        pageChecks,
        links,
    };
}

function validatePage(report) {
    const checks = {
        pageLoaded: ["interactive", "complete"].includes(report.readyState),
        hasTitle: report.hasTitle,
        hasContent: report.textLength > 0,
        pageChecksPass: report.pageChecks.every((check) => check.passed),
    };

    return {
        passed: Object.values(checks).every(Boolean),
        checks,
        report,
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }

    for (const dir of [tmpDir, outputDir, logDir, resolve(options.output, ".."), resolve(options.report, ".."), resolve(options.log, "..")]) {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    const port = await getFreePort(options.host);
    const endpoint = `http://${options.host}:${port}`;
    // TikTok (and many other origins) block requests whose User-Agent
    // is "Velora/1.0", returning HTTP 403 before any page content is
    // delivered. Override it with a stock Chrome UA so the bot-detection
    // path is bypassed for this end-to-end check.
    const userAgent = options.userAgent
        || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    const proc = spawn(veloraBin, [
        "serve",
        "--host", options.host,
        "--port", String(port),
        "--log-level", options.logLevel,
        "--log-format", options.logFormat,
        "--http-timeout", String(options.httpTimeoutMs),
        "--user-agent", userAgent,
    ], {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    proc.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    let cdp;
    let targetId;
    let sessionId;
    try {
        await waitForServer(`${endpoint}/json/version`, options.serverTimeoutMs);
        cdp = await connectCDP(endpoint, options);
        ({ targetId, sessionId } = await createPageSession(cdp));

        await cdp.send("Runtime.enable", {}, sessionId);
        await cdp.send("Page.enable", {}, sessionId);
        await cdp.send("Network.enable", {}, sessionId).catch(() => undefined);

        console.log(`[navigate:cdp] ${options.url}`);
        await navigate(cdp, sessionId, options.url, options.navigationTimeoutMs);
        console.log(`[wait] ${options.waitMs}ms`);
        await delay(options.waitMs);

        console.log("[inspect] collecting page report");
        const pageReport = await evaluate(cdp, sessionId, `(() => {
            ${createPageTestRecorder.toString()}
            ${testPage.toString()}
            ${inspectPage.toString()}
            return inspectPage();
        })()`, options.commandTimeoutMs);
        const result = validatePage(pageReport);
        const html = await getPageContent(cdp, sessionId, options.commandTimeoutMs, pageReport.url || options.url);

        writeFileSync(options.output, html);
        writeFileSync(options.report, `${JSON.stringify(result, null, 2)}\n`);

        console.log(JSON.stringify(result, null, 2));
        console.log(`saved html: ${options.output}`);
        console.log(`saved report: ${options.report}`);

        if (!result.passed) {
            console.warn("page check did not fully pass; see report for details");
            process.exitCode = 1;
        }
    } finally {
        console.log("[cleanup] closing CDP and Velora");
        if (cdp && targetId) {
            await cdp.send("Target.closeTarget", { targetId }, undefined, options.commandTimeoutMs).catch(() => undefined);
        }
        if (cdp) cdp.close();

        const procExited = proc.exitCode != null || proc.signalCode != null
            ? Promise.resolve()
            : new Promise((resolvePromise) => proc.once("exit", resolvePromise));
        if (proc.exitCode == null && !proc.killed) proc.kill("SIGTERM");
        await procExited;

        const stdout = Buffer.concat(stdoutChunks).toString();
        const stderr = Buffer.concat(stderrChunks).toString();
        writeFileSync(options.log, "");
        appendSection(options.log, "VELORA STDOUT", stdout);
        appendSection(options.log, "VELORA STDERR", stderr);
        console.log(`saved log: ${options.log}`);
    }
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
});
