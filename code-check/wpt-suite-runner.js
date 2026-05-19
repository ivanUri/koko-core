#!/usr/bin/env node
// Run many WPT testharness tests in both Velora and Chromium, then write an HTML comparison report.

const { spawn } = require("node:child_process");
const { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { createServer: createHttpServer } = require("node:http");
const { createServer: createNetServer } = require("node:net");
const { extname, normalize, relative, resolve, sep } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const wptRoot = resolve(repoRoot, "wpt");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const tmpDir = resolve(repoRoot, "code-check/tmp");
const outputDir = resolve(tmpDir, "output");
const logDir = resolve(tmpDir, "logs");

const defaults = {
    host: "127.0.0.1",
    root: "wpt/html/dom",
    limit: 50,
    report: resolve(outputDir, "wpt-suite-report.json"),
    html: resolve(outputDir, "wpt-suite-report.html"),
    log: resolve(logDir, "wpt-suite-runner.log"),
    serverTimeoutMs: 3000,
    commandTimeoutMs: 15000,
    navigationTimeoutMs: 20000,
    testTimeoutMs: 20000,
    httpTimeoutMs: 30000,
    logLevel: "debug",
    logFormat: "pretty",
    includeManual: false,
    failFast: false,
    debugLifecycle: false,
    rawCdpTrace: false,
    debugDir: resolve(outputDir, "wpt-debug"),
};

const statusNames = ["PASS", "FAIL", "TIMEOUT", "NOTRUN"];
const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".xhtml": "application/xhtml+xml; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
};

function usage() {
    return `Usage: node code-check/wpt-suite-runner.js [options]\n\nOptions:\n  --root <path>          WPT directory or file to scan (default: ${defaults.root})\n  --limit <n>            Max files to run; 0 means unlimited (default: ${defaults.limit})\n  --include-manual       Include manual/no-harness pages as inventory rows\n  --fail-fast            Stop after the first AUTO mismatch\n  --report <path>        JSON report path (default: ${defaults.report})\n  --html <path>          HTML report path (default: ${defaults.html})\n  --timeout <ms>         Per-test max wait guardrail (default: ${defaults.testTimeoutMs})\n  --command-timeout <ms> CDP command timeout (default: ${defaults.commandTimeoutMs})\n  --log-level <level>    Velora log level (default: ${defaults.logLevel})\n  --help                 Show this help\n\nExamples:\n  npm run test:wpt:suite\n  npm run test:wpt:suite -- --root wpt/html/dom --limit 20\n  npm run test:wpt:suite -- --root wpt/html/dom --limit 20 --timeout 1000 --fail-fast\n  npm run test:wpt:suite -- --root wpt --limit 0 --include-manual\n`;
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
            case "--root": options.root = next(); break;
            case "--limit": options.limit = Number(next()); break;
            case "--include-manual": options.includeManual = true; break;
            case "--fail-fast": options.failFast = true; break;
            case "--report": options.report = resolve(next()); break;
            case "--html": options.html = resolve(next()); break;
            case "--log": options.log = resolve(next()); break;
            case "--timeout": options.testTimeoutMs = Number(next()); break;
            case "--command-timeout": options.commandTimeoutMs = Number(next()); break;
            case "--log-level": options.logLevel = next(); break;
            case "--debug-lifecycle": options.debugLifecycle = true; break;
            case "--raw-cdp-trace": options.rawCdpTrace = true; options.debugLifecycle = true; break;
            case "--debug-dir": options.debugDir = resolve(next()); break;
            case "--help":
            case "-h": options.help = true; break;
            default: throw new Error(`Unknown option: ${arg}`);
        }
    }
    for (const key of ["limit", "serverTimeoutMs", "commandTimeoutMs", "navigationTimeoutMs", "testTimeoutMs", "httpTimeoutMs"]) {
        if (!Number.isFinite(options[key]) || options[key] < 0) throw new Error(`Invalid ${key}: ${options[key]}`);
    }
    return options;
}

function delay(ms) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function stopProcess(proc, signal = "SIGTERM", timeoutMs = 2000) {
    if (proc.exitCode != null || proc.signalCode != null) return;
    const exited = new Promise((resolvePromise) => proc.once("exit", resolvePromise));
    proc.kill(signal);
    const timedOut = await Promise.race([exited.then(() => false), delay(timeoutMs).then(() => true)]);
    if (timedOut && proc.exitCode == null && proc.signalCode == null) {
        proc.kill("SIGKILL");
        await exited;
    }
}

async function getFreePort(host) {
    return new Promise((resolvePromise, reject) => {
        const server = createNetServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, host, () => {
            const { port } = server.address();
            server.close(() => resolvePromise(port));
        });
    });
}

async function waitForServer(url, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
        try {
            const res = await fetch(url);
            if (res.ok) return;
        } catch (_) {
            // Server is still starting.
        }
        await delay(250);
    }
    throw new Error(`Timed out waiting for ${url}`);
}

function ensureDir(path) {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function toWptRelativePath(testPath) {
    const absolute = resolve(testPath);
    const rel = relative(wptRoot, absolute).split(sep).join("/");
    if (!rel.startsWith("..") && rel !== "") return rel;
    const normalized = testPath.replace(/\\/g, "/").replace(/^\.\//, "");
    return normalized.startsWith("wpt/") ? normalized.slice(4) : normalized;
}

function resolveStaticPath(urlPath) {
    const decodedPath = decodeURIComponent(urlPath.split("?")[0]);
    const safePath = normalize(decodedPath).replace(/^(\.\.(?:[/\\]|$))+/, "");
    const absolute = resolve(wptRoot, `.${safePath}`);
    if (!absolute.startsWith(wptRoot + sep) && absolute !== wptRoot) return null;
    return absolute;
}

function startStaticServer(host, port) {
    const server = createHttpServer((req, res) => {
        const urlPath = (req.url || "/").split("?")[0];
        if (urlPath === "/resources/testharnessreport.js") {
            res.writeHead(200, { "content-type": contentTypes[".js"] });
            res.end(`(() => {
                const serializeStatus = (status) => ({
                    status: status && typeof status.status === 'number' ? status.status : 2,
                    message: status && status.message ? String(status.message) : '',
                    stack: status && status.stack ? String(status.stack) : ''
                });
                const serializeTest = (test) => ({
                    name: test.name,
                    status: test.status,
                    message: test.message || '',
                    stack: test.stack || ''
                });
                window.__veloraWptResults = [];
                window.__veloraWptDone = null;
                if (typeof add_result_callback === 'function') {
                    add_result_callback((test) => window.__veloraWptResults.push(serializeTest(test)));
                }
                if (typeof add_completion_callback === 'function') {
                    add_completion_callback((tests, status) => {
                        window.__veloraWptDone = {
                            status: serializeStatus(status),
                            tests: Array.prototype.slice.call(tests || []).map(serializeTest)
                        };
                    });
                }
            })();`);
            return;
        }
        const filePath = resolveStaticPath(req.url || "/");
        if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) {
            res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
            res.end("Not found");
            return;
        }
        res.writeHead(200, { "content-type": contentTypes[extname(filePath)] || "application/octet-stream" });
        createReadStream(filePath).pipe(res);
    });
    return new Promise((resolvePromise, reject) => {
        server.on("error", reject);
        server.listen(port, host, () => resolvePromise(server));
    });
}

function createDiagnostics(options) {
    const events = [];
    let currentTest = null;
    const ws = { readyState: "CONNECTING", close: null, errors: [] };
    const processState = { alive: true, unexpectedDeathDuringTest: false, events: [] };
    const state = {
        targets: new Map(),
        sessions: new Map(),
        frames: new Map(),
        executionContexts: new Map(),
        lifecycle: new Map(),
    };

    function compact(details = {}) {
        const out = {};
        for (const [key, value] of Object.entries(details)) {
            if (value !== undefined && value !== null) out[key] = value;
        }
        return out;
    }

    function logEvent(category, type, details = {}) {
        const event = { timestamp: new Date().toISOString(), category, type, test: currentTest, ...compact(details) };
        events.push(event);
        return event;
    }

    function setCurrentTest(test) { currentTest = test; }

    function snapshot() {
        const mapToArray = (map) => Array.from(map.entries()).map(([id, value]) => ({ id, ...value }));
        return {
            ws,
            process: processState,
            targets: mapToArray(state.targets),
            sessions: mapToArray(state.sessions),
            frames: mapToArray(state.frames),
            executionContexts: mapToArray(state.executionContexts),
            lifecycle: mapToArray(state.lifecycle),
        };
    }

    function writeArtifacts() {
        if (!options.debugLifecycle) return;
        ensureDir(options.debugDir);
        writeFileSync(resolve(options.debugDir, "lifecycle-timeline.ndjson"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
        writeFileSync(resolve(options.debugDir, "state-snapshot.json"), `${JSON.stringify(snapshot(), null, 2)}\n`);
    }

    return { events, state, ws, processState, logEvent, setCurrentTest, snapshot, writeArtifacts };
}

function cdpError(category, message, details = {}) {
    const err = new Error(message);
    err.category = category;
    err.details = details;
    return err;
}

function classifyFailure(err) {
    if (!err) return undefined;
    if (err.category) return err.category;
    const message = String(err.message || err);
    if (/websocket.*not open|websocket closed|CDP client closed/i.test(message)) return "WS_CLOSED";
    if (/detached/i.test(message)) return "TARGET_DETACHED";
    if (/context.*destroy/i.test(message)) return "CONTEXT_DESTROYED";
    if (/navigate|lifecycle/i.test(message) && /timed out|timeout/i.test(message)) return "NAVIGATION_TIMEOUT";
    if (/Runtime\.evaluate|evaluate/i.test(message)) return "EVALUATE_FAILED";
    if (/harness.*timed out|Timed out after/i.test(message)) return "HARNESS_TIMEOUT";
    if (/process.*exit|process.*closed/i.test(message)) return "PROCESS_EXIT";
    if (/crash/i.test(message)) return "CRASH";
    return "EVALUATE_FAILED";
}

async function connectCDP(cdpEndpoint, options, diagnostics = createDiagnostics(options)) {
    const versionRes = await fetch(`${cdpEndpoint}/json/version`);
    if (!versionRes.ok) throw new Error(`Unable to read CDP version: HTTP ${versionRes.status}`);
    const { webSocketDebuggerUrl } = await versionRes.json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    const callbacks = new Map();
    const listeners = new Map();
    let nextId = 1;
    let closed = false;

    function readyStateName() {
        return ["CONNECTING", "OPEN", "CLOSING", "CLOSED"][ws.readyState] || String(ws.readyState);
    }

    function emit(method, payload) {
        for (const handler of listeners.get(method) || []) handler(payload);
        for (const handler of listeners.get("*") || []) handler(payload);
    }

    function rejectPending(err) {
        for (const [id, callback] of callbacks) {
            if (callback.timer) clearTimeout(callback.timer);
            callback.reject(err);
            callbacks.delete(id);
        }
    }

    ws.addEventListener("message", (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch (err) {
            diagnostics.logEvent("CDP", "parse_error", { error: err.message });
            return;
        }
        if (message.method) {
            const payload = { method: message.method, params: message.params || {}, sessionId: message.sessionId };
            if (options.rawCdpTrace) diagnostics.logEvent("CDP", "event", payload);
            emit(message.method, payload);
            return;
        }
        if (message.id == null || !callbacks.has(message.id)) return;
        const callback = callbacks.get(message.id);
        callbacks.delete(message.id);
        if (callback.timer) clearTimeout(callback.timer);
        if (message.error) callback.reject(cdpError("EVALUATE_FAILED", `${callback.method}: ${message.error.message} (${message.error.code})`, { method: callback.method, code: message.error.code }));
        else callback.resolve(message.result || {});
    });

    await new Promise((resolvePromise, reject) => {
        ws.addEventListener("open", () => {
            diagnostics.ws.readyState = readyStateName();
            diagnostics.logEvent("WS", "open", { readyState: diagnostics.ws.readyState });
            resolvePromise();
        }, { once: true });
        ws.addEventListener("error", (event) => {
            const err = cdpError("WS_CLOSED", "CDP websocket transport error", { readyState: readyStateName(), error: event.message || String(event.type || "error") });
            diagnostics.ws.errors.push(err.details);
            diagnostics.logEvent("WS", "error", err.details);
            reject(err);
        }, { once: true });
    });
    ws.addEventListener("error", (event) => {
        diagnostics.ws.readyState = readyStateName();
        const details = { readyState: diagnostics.ws.readyState, error: event.message || String(event.type || "error") };
        diagnostics.ws.errors.push(details);
        diagnostics.logEvent("WS", "error", details);
    });
    ws.addEventListener("close", (event) => {
        closed = true;
        diagnostics.ws.readyState = readyStateName();
        diagnostics.ws.close = { code: event.code, reason: event.reason || "", wasClean: event.wasClean, readyState: diagnostics.ws.readyState };
        diagnostics.logEvent("WS", "close", diagnostics.ws.close);
        rejectPending(cdpError("WS_CLOSED", `CDP websocket closed: code=${event.code} reason=${event.reason || ""}`, diagnostics.ws.close));
    });

    return {
        diagnostics,
        on(method, handler) {
            if (!listeners.has(method)) listeners.set(method, new Set());
            listeners.get(method).add(handler);
            return () => listeners.get(method)?.delete(handler);
        },
        isOpen() { return !closed && ws.readyState === WebSocket.OPEN; },
        send(method, params = {}, sessionId, timeoutMs = options.commandTimeoutMs) {
            diagnostics.logEvent("CDP", "send", { method, sessionId, readyState: readyStateName() });
            if (closed || ws.readyState !== WebSocket.OPEN) {
                return Promise.reject(cdpError("WS_CLOSED", `Cannot send ${method}: CDP websocket is not open`, { method, sessionId, readyState: readyStateName(), wsClose: diagnostics.ws.close }));
            }
            const id = nextId++;
            const payload = { id, method, params };
            if (sessionId) payload.sessionId = sessionId;
            return new Promise((resolvePromise, reject) => {
                const timer = timeoutMs ? setTimeout(() => {
                    callbacks.delete(id);
                    const category = method === "Page.navigate" ? "NAVIGATION_TIMEOUT" : method === "Runtime.evaluate" ? "EVALUATE_FAILED" : "HARNESS_TIMEOUT";
                    reject(cdpError(category, `${method} timed out after ${timeoutMs}ms`, { method, sessionId, timeoutMs }));
                }, timeoutMs) : null;
                callbacks.set(id, { method, resolve: resolvePromise, reject, timer });
                ws.send(JSON.stringify(payload));
            });
        },
        close() {
            closed = true;
            diagnostics.logEvent("WS", "client_close", { readyState: readyStateName() });
            rejectPending(cdpError("WS_CLOSED", "CDP client closed"));
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
        },
    };
}

function setupCdpStateTracking(cdp) {
    const { diagnostics } = cdp;
    const important = new Set([
        "Target.attachedToTarget", "Target.detachedFromTarget", "Inspector.detached",
        "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared",
        "Page.frameAttached", "Page.frameDetached", "Page.frameNavigated", "Page.lifecycleEvent",
    ]);
    cdp.on("*", ({ method, params, sessionId }) => {
        if (!important.has(method)) return;
        const details = { sessionId };
        if (params.targetInfo) {
            details.targetId = params.targetInfo.targetId;
            details.type = params.targetInfo.type;
            details.url = params.targetInfo.url;
        }
        if (params.targetId) details.targetId = params.targetId;
        if (params.frameId) details.frameId = params.frameId;
        if (params.parentFrameId) details.parentFrameId = params.parentFrameId;
        if (params.executionContextId) details.executionContextId = params.executionContextId;
        if (params.context?.id) details.executionContextId = params.context.id;
        if (params.context?.auxData?.frameId) details.frameId = params.context.auxData.frameId;
        if (params.frame?.id) details.frameId = params.frame.id;
        if (params.frame?.url) details.url = params.frame.url;
        if (params.name) details.name = params.name;
        if (params.reason) details.reason = params.reason;
        diagnostics.logEvent("CDP", method, details);

        if (method === "Target.attachedToTarget") {
            diagnostics.state.targets.set(params.targetInfo.targetId, { attached: true, sessionId, url: params.targetInfo.url, type: params.targetInfo.type });
            diagnostics.state.sessions.set(params.sessionId, { attached: true, targetId: params.targetInfo.targetId });
        } else if (method === "Target.detachedFromTarget") {
            const session = diagnostics.state.sessions.get(params.sessionId) || {};
            diagnostics.state.sessions.set(params.sessionId, { ...session, attached: false, reason: params.reason });
            for (const [id, context] of diagnostics.state.executionContexts) {
                if (context.sessionId === params.sessionId) diagnostics.state.executionContexts.set(id, { ...context, alive: false, detached: true });
            }
        } else if (method === "Inspector.detached") {
            const session = diagnostics.state.sessions.get(sessionId) || {};
            diagnostics.state.sessions.set(sessionId, { ...session, attached: false, reason: params.reason });
            for (const [id, context] of diagnostics.state.executionContexts) {
                if (context.sessionId === sessionId) diagnostics.state.executionContexts.set(id, { ...context, alive: false, detached: true });
            }
        } else if (method === "Runtime.executionContextCreated") {
            const context = params.context || {};
            diagnostics.state.executionContexts.set(String(context.id), { sessionId, frameId: context.auxData?.frameId, name: context.name, origin: context.origin, alive: true });
        } else if (method === "Runtime.executionContextDestroyed") {
            const existing = diagnostics.state.executionContexts.get(String(params.executionContextId)) || {};
            diagnostics.state.executionContexts.set(String(params.executionContextId), { ...existing, alive: false });
        } else if (method === "Runtime.executionContextsCleared") {
            for (const [id, context] of diagnostics.state.executionContexts) {
                if (!sessionId || context.sessionId === sessionId) diagnostics.state.executionContexts.set(id, { ...context, alive: false, cleared: true });
            }
        } else if (method === "Page.frameAttached") {
            diagnostics.state.frames.set(params.frameId, { sessionId, parentFrameId: params.parentFrameId, attached: true });
        } else if (method === "Page.frameDetached") {
            const frame = diagnostics.state.frames.get(params.frameId) || {};
            diagnostics.state.frames.set(params.frameId, { ...frame, sessionId, attached: false, reason: params.reason });
        } else if (method === "Page.frameNavigated") {
            const frame = params.frame || {};
            diagnostics.state.frames.set(frame.id, { ...(diagnostics.state.frames.get(frame.id) || {}), sessionId, url: frame.url, attached: true });
        } else if (method === "Page.lifecycleEvent") {
            const key = `${sessionId || "root"}:${params.frameId || "main"}:${params.name}`;
            diagnostics.state.lifecycle.set(key, { sessionId, frameId: params.frameId, name: params.name, timestamp: params.timestamp });
        }
    });
}

function logInvariant(cdp, type, page = {}, extra = {}) {
    const session = page.sessionId ? cdp.diagnostics.state.sessions.get(page.sessionId) : null;
    const contextExists = Array.from(cdp.diagnostics.state.executionContexts.values()).some((context) => context.sessionId === page.sessionId && context.alive !== false);
    cdp.diagnostics.logEvent("INVARIANT", type, {
        targetId: page.targetId,
        sessionId: page.sessionId,
        websocketOpen: cdp.isOpen(),
        sessionAttached: page.sessionId ? session?.attached !== false : undefined,
        targetAlive: page.targetId ? cdp.diagnostics.state.targets.get(page.targetId)?.attached !== false : undefined,
        executionContextExists: page.sessionId ? contextExists : undefined,
        ...extra,
    });
}

function assertPostCloseInvariant(cdp, page = {}) {
    const session = page.sessionId ? cdp.diagnostics.state.sessions.get(page.sessionId) : null;
    const aliveContexts = Array.from(cdp.diagnostics.state.executionContexts.entries())
        .filter(([, context]) => context.sessionId === page.sessionId && context.alive !== false)
        .map(([id, context]) => ({ id, frameId: context.frameId, name: context.name }));

    if (session?.attached !== false || aliveContexts.length > 0) {
        throw cdpError("CONTEXT_LEAK", "Target close left CDP session or execution contexts alive", {
            targetId: page.targetId,
            sessionId: page.sessionId,
            sessionAttached: session?.attached,
            aliveContexts,
        });
    }
}

async function waitForLifecycle(cdp, sessionId, options) {
    const timeoutMs = options.navigationTimeoutMs;
    const alreadyReady = () => {
        const hasContext = Array.from(cdp.diagnostics.state.executionContexts.values()).some((context) => context.sessionId === sessionId && context.alive !== false);
        const hasDomReady = Array.from(cdp.diagnostics.state.lifecycle.values()).some((event) => event.sessionId === sessionId && /DOMContentLoaded/i.test(event.name || ""));
        return hasContext || hasDomReady;
    };
    if (alreadyReady()) return { ready: true, source: "cached" };
    return new Promise((resolvePromise, reject) => {
        const cleanup = [];
        const done = (value) => { cleanup.forEach((fn) => fn()); resolvePromise(value); };
        const fail = (err) => { cleanup.forEach((fn) => fn()); reject(err); };
        const timer = setTimeout(() => fail(cdpError("NAVIGATION_TIMEOUT", `Lifecycle wait timed out after ${timeoutMs}ms`, { sessionId, timeoutMs })), timeoutMs);
        cleanup.push(() => clearTimeout(timer));
        cleanup.push(cdp.on("Runtime.executionContextCreated", (event) => {
            if (event.sessionId === sessionId) done({ ready: true, source: "executionContextCreated", executionContextId: event.params.context?.id });
        }));
        cleanup.push(cdp.on("Page.lifecycleEvent", (event) => {
            if (event.sessionId === sessionId && /DOMContentLoaded/i.test(event.params.name || "")) done({ ready: true, source: "Page.lifecycleEvent", frameId: event.params.frameId });
        }));
        cleanup.push(cdp.on("Page.domContentEventFired", (event) => {
            if (event.sessionId === sessionId) done({ ready: true, source: "Page.domContentEventFired" });
        }));
        cleanup.push(cdp.on("Target.detachedFromTarget", (event) => {
            if (event.params.sessionId === sessionId) fail(cdpError("TARGET_DETACHED", "Target detached while waiting for lifecycle", { sessionId, reason: event.params.reason }));
        }));
        cleanup.push(cdp.on("Inspector.detached", (event) => {
            if (event.sessionId === sessionId) fail(cdpError("TARGET_DETACHED", "Inspector detached while waiting for lifecycle", { sessionId, reason: event.params.reason }));
        }));
    });
}

async function createVeloraPage(cdp) {
    logInvariant(cdp, "before_target_create");
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    cdp.diagnostics.state.targets.set(targetId, { attached: true, sessionId, url: "about:blank" });
    cdp.diagnostics.state.sessions.set(sessionId, { attached: true, targetId });
    const page = { targetId, sessionId };
    logInvariant(cdp, "after_target_attach", page);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }, sessionId).catch((err) => cdp.diagnostics.logEvent("LIFECYCLE", "enable_failed", { sessionId, error: err.message }));
    return page;
}

const wptResultHookExpression = `(() => {
    const serializeStatus = (status) => ({
        status: status && typeof status.status === 'number' ? status.status : 2,
        message: status && status.message ? String(status.message) : '',
        stack: status && status.stack ? String(status.stack) : ''
    });
    const serialize = (tests, status) => ({
        status: serializeStatus(status),
        tests: (tests || []).map((test) => ({
            name: test.name,
            status: test.status,
            message: test.message || '',
            stack: test.stack || ''
        }))
    });
    const install = () => {
        if (window.__veloraWptDone || window.__veloraWptInstalled) return true;
        if (typeof add_completion_callback !== 'function') return false;
        window.__veloraWptInstalled = true;
        add_completion_callback((tests, status) => {
            window.__veloraWptDone = serialize(tests, status);
        });
        return true;
    };
    if (!install()) {
        Object.defineProperty(window, '__veloraInstallWptHook', { value: install, configurable: true });
        queueMicrotask(install);
        setTimeout(install, 0);
    }
})()`;

async function evaluate(cdp, sessionId, expression, timeoutMs) {
    logInvariant(cdp, "before_runtime_evaluate", { sessionId });
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId, timeoutMs);
    if (result.exceptionDetails) throw cdpError("EVALUATE_FAILED", `Runtime.evaluate failed: ${JSON.stringify(result.exceptionDetails)}`, { sessionId });
    logInvariant(cdp, "after_runtime_evaluate", { sessionId });
    return result.result ? result.result.value : undefined;
}

async function collectDebugProbe(cdp, sessionId, timeoutMs = 500) {
    try {
        return await evaluate(cdp, sessionId, `(() => ({
            readyState: document.readyState,
            url: location.href,
            hasTestHarness: typeof add_completion_callback === 'function',
            installed: Boolean(window.__veloraWptInstalled),
            done: Boolean(window.__veloraWptDone),
            resultCount: Array.isArray(window.__veloraWptResults) ? window.__veloraWptResults.length : null,
            reflectionHarness: typeof window.ReflectionHarness,
            reflectionElements: typeof window.elements === 'object' && window.elements ? Object.keys(window.elements).length : null
        }))()`, timeoutMs);
    } catch (err) {
        return { probeError: err.message, category: classifyFailure(err) };
    }
}

async function collectVeloraWptResults(cdp, sessionId, timeoutMs) {
    await evaluate(cdp, sessionId, `(() => (window.__veloraInstallWptHook && window.__veloraInstallWptHook()) || false)()`, 500);

    const started = Date.now();
    let lastEvaluateError;
    while (Date.now() - started <= timeoutMs) {
        const remaining = timeoutMs - (Date.now() - started);
        const report = await evaluate(cdp, sessionId, `(() => window.__veloraWptDone || null)()`, Math.max(1, Math.min(remaining, 250))).catch((err) => {
            lastEvaluateError = err;
            cdp.diagnostics.logEvent("RUNTIME", "poll_evaluate_failed", { sessionId, error: err.message, category: classifyFailure(err) });
            return null;
        });
        if (report) return report;
        await delay(250);
    }
    const fallback = await evaluate(cdp, sessionId, `(() => {
        if (window.__veloraWptResults && window.__veloraWptResults.length > 0) {
            return { status: { status: 2, message: 'WPT harness did not complete' }, tests: window.__veloraWptResults };
        }
        return null;
    })()`, 250).catch((err) => {
        lastEvaluateError = err;
        cdp.diagnostics.logEvent("RUNTIME", "fallback_evaluate_failed", { sessionId, error: err.message, category: classifyFailure(err) });
        return null;
    });
    if (fallback) return fallback;
    if (lastEvaluateError) throw lastEvaluateError;
    return { status: { status: 2, message: `Timed out after ${timeoutMs}ms` }, tests: [] };
}

async function runVeloraTest(cdp, testUrl, options) {
    let page;
    try {
        page = await createVeloraPage(cdp);
        logInvariant(cdp, "before_navigation", page, { url: testUrl });
        await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: wptResultHookExpression }, page.sessionId, options.commandTimeoutMs).catch((err) => cdp.diagnostics.logEvent("PAGE", "add_script_failed", { sessionId: page.sessionId, error: err.message }));
        await cdp.send("Page.navigate", { url: testUrl }, page.sessionId, options.navigationTimeoutMs);
        const lifecycle = await waitForLifecycle(cdp, page.sessionId, options);
        cdp.diagnostics.logEvent("LIFECYCLE", "navigation_ready", { sessionId: page.sessionId, targetId: page.targetId, source: lifecycle.source, frameId: lifecycle.frameId, executionContextId: lifecycle.executionContextId });
        logInvariant(cdp, "after_navigation", page, { url: testUrl });
        const report = await collectVeloraWptResults(cdp, page.sessionId, options.testTimeoutMs);
        return { ok: true, category: undefined, report, diagnostics: { targetId: page.targetId, sessionId: page.sessionId } };
    } catch (err) {
        const category = classifyFailure(err);
        const probe = page?.sessionId && cdp.isOpen() ? await collectDebugProbe(cdp, page.sessionId).catch((probeErr) => ({ probeError: probeErr.message })) : null;
        cdp.diagnostics.logEvent("RUNTIME", "test_failed", { category, error: err.message, targetId: page?.targetId, sessionId: page?.sessionId, probe });
        return { ok: false, category, error: err.message, report: { status: { status: 2, message: err.message }, tests: [] }, diagnostics: { targetId: page?.targetId, sessionId: page?.sessionId, details: err.details, probe } };
    } finally {
        if (page) {
            logInvariant(cdp, "before_target_close", page);
            await cdp.send("Target.closeTarget", { targetId: page.targetId }, undefined, options.commandTimeoutMs).catch((err) => cdp.diagnostics.logEvent("TARGET", "close_failed", { targetId: page.targetId, error: err.message, category: classifyFailure(err) }));
            await delay(0);
            logInvariant(cdp, "after_target_close", page);
            try {
                assertPostCloseInvariant(cdp, page);
            } catch (err) {
                cdp.diagnostics.logEvent("INVARIANT", "post_close_failed", { targetId: page.targetId, sessionId: page.sessionId, error: err.message, details: err.details });
            }
        }
    }
}

async function runChromiumTest(browser, testUrl, timeoutMs) {
    let page;
    try {
        page = await browser.newPage();
        await page.goto(testUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        const report = await page.waitForFunction(() => window.__veloraWptDone || null, null, { timeout: timeoutMs }).then((handle) => handle.jsonValue());
        return { ok: true, report };
    } catch (err) {
        return { ok: false, category: classifyFailure(err), error: err.message, report: { status: { status: 2, message: err.message }, tests: [] } };
    } finally {
        if (page) await page.close().catch(() => undefined);
    }
}

function statusName(status) {
    return statusNames[status] || "NOTRUN";
}

function summarize(report) {
    const counts = { total: 0, pass: 0, fail: 0, timeout: 0, notrun: 0 };
    for (const test of report.tests || []) {
        counts.total += 1;
        if (test.status === 0) counts.pass += 1;
        else if (test.status === 1) counts.fail += 1;
        else if (test.status === 2) counts.timeout += 1;
        else counts.notrun += 1;
    }
    return counts;
}

function testsToMap(report) {
    const map = new Map();
    for (const test of report.tests || []) map.set(test.name, { status: statusName(test.status), message: test.message || "" });
    return map;
}

function compareTestReports(chromeRun, veloraRun) {
    if (!veloraRun.ok && (veloraRun.report?.tests || []).length === 0) {
        return {
            rows: [{
                name: "(file-level Velora failure)",
                chrome: `${(chromeRun.report?.tests || []).length} subtests`,
                velora: veloraRun.category || "ERROR",
                chromeMessage: chromeRun.ok ? "Chrome completed; subtest comparison skipped because Velora produced no report." : chromeRun.error || "",
                veloraMessage: veloraRun.error || veloraRun.report?.status?.message || "Velora produced no report.",
                match: false,
            }],
            mismatches: 1,
            fileLevelFailure: true,
        };
    }
    const chrome = testsToMap(chromeRun.report);
    const velora = testsToMap(veloraRun.report);
    const names = Array.from(new Set([...chrome.keys(), ...velora.keys()])).sort();
    const rows = names.map((name) => {
        const chromeResult = chrome.get(name) || { status: "MISSING", message: "" };
        const veloraResult = velora.get(name) || { status: "MISSING", message: "" };
        return {
            name,
            chrome: chromeResult.status,
            velora: veloraResult.status,
            chromeMessage: chromeResult.message,
            veloraMessage: veloraResult.message,
            match: chromeResult.status === veloraResult.status,
        };
    });
    return { rows, mismatches: rows.filter((row) => !row.match).length };
}

function classifyTestFile(absPath) {
    const text = readFileSync(absPath, "utf8");
    const lower = absPath.toLowerCase();
    if (lower.includes("-manual.") || /manual/i.test(text.slice(0, 2000))) return "MANUAL";
    if (text.includes("/resources/testharness.js") || text.includes("resources/testharness.js") || text.includes("testharness.js")) return "AUTO";
    return "NO_HARNESS";
}

function scanTests(rootPath, includeManual, limit) {
    const start = resolve(rootPath);
    if (!existsSync(start)) throw new Error(`WPT root not found: ${rootPath}`);
    const files = [];
    const visit = (path) => {
        const stat = statSync(path);
        if (stat.isDirectory()) {
            for (const name of readdirSync(path).sort()) {
                if (name.startsWith(".")) continue;
                visit(resolve(path, name));
                if (limit > 0 && files.length >= limit) return;
            }
            return;
        }
        if (!stat.isFile() || ![".html", ".xhtml"].includes(extname(path))) return;
        const type = classifyTestFile(path);
        if (type === "AUTO" || includeManual) files.push({ absPath: path, rel: toWptRelativePath(path), type });
    };
    visit(start);
    return files;
}

function htmlEscape(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[ch]));
}

function summaryText(counts) {
    return `${counts.pass}P ${counts.fail}F ${counts.timeout}T ${counts.notrun}N / ${counts.total}`;
}

function resultBars(counts) {
    const total = Math.max(counts.total, 1);
    const parts = [
        ["pass", "PASS", counts.pass],
        ["fail", "FAIL", counts.fail],
        ["timeout", "TIMEOUT", counts.timeout],
        ["notrun", "NOTRUN", counts.notrun],
    ];
    const chips = parts.map(([kind, label, value]) => `<span class="count ${kind}">${label} <b>${value}</b></span>`).join("");
    const bars = parts.map(([kind, , value]) => `<span class="bar ${kind}" style="width:${(value / total) * 100}%"></span>`).join("");
    return `<div class="resultBox"><div class="counts">${chips}</div><div class="stack">${bars}</div><div class="total">${counts.total} subtests</div></div>`;
}

function deltaText(chrome, velora) {
    const fields = [["PASS", "pass"], ["FAIL", "fail"], ["TIMEOUT", "timeout"], ["NOTRUN", "notrun"]];
    return fields.map(([label, key]) => {
        const delta = velora[key] - chrome[key];
        const sign = delta > 0 ? "+" : "";
        const klass = delta === 0 ? "same" : delta > 0 ? "up" : "down";
        return `<span class="delta ${klass}">${label} ${sign}${delta}</span>`;
    }).join("");
}

function writeHtmlReport(path, report) {
    const totals = report.totals;
    const rows = report.results.map((item) => {
        const mismatchRows = item.comparison.rows.filter((row) => !row.match).slice(0, 12).map((row, index) => (
            `<tr><td class="idx">${index + 1}</td><td class="subtestName">${htmlEscape(row.name)}</td><td><span class="status ${String(row.chrome).toLowerCase()}">${htmlEscape(row.chrome)}</span></td><td class="message">${htmlEscape(row.chromeMessage || "-")}</td><td><span class="status ${String(row.velora).toLowerCase()}">${htmlEscape(row.velora)}</span></td><td class="message">${htmlEscape(row.veloraMessage || "-")}</td></tr>`
        )).join("");
        const mismatchDetails = mismatchRows
            ? `<table class="detailTable"><thead><tr><th>STT</th><th>Subtest</th><th>Chrome</th><th>Chrome Message</th><th>Velora</th><th>Velora Message</th></tr></thead><tbody>${mismatchRows}</tbody></table>`
            : "<span class=muted>None</span>";
        const status = item.type !== "AUTO" ? "SKIPPED_MANUAL" : item.comparison.mismatches === 0 ? "MATCH" : "MISMATCH";
        const diag = item.velora?.category ? `<div class="diag"><b>${htmlEscape(item.velora.category)}</b> ${htmlEscape(item.velora.error || "")}</div>` : "";
        return `<tr class="summaryRow" data-status="${status}" data-type="${item.type}" data-velora-fail="${item.velora.counts.fail > 0}" data-chrome-fail="${item.chrome.counts.fail > 0}">
<td><code>${htmlEscape(item.test)}</code></td>
<td><span class="pill ${item.type.toLowerCase()}">${item.type}</span></td>
<td>${resultBars(item.chrome.counts)}</td>
<td>${resultBars(item.velora.counts)}</td>
<td><div><span class="pill ${status.toLowerCase()}">${status}</span></div><div class="deltas">${deltaText(item.chrome.counts, item.velora.counts)}</div>${diag}</td>
<td class="num bigMismatch">${item.comparison.mismatches}</td>
</tr><tr class="detailRow" data-status="${status}" data-type="${item.type}" data-velora-fail="${item.velora.counts.fail > 0}" data-chrome-fail="${item.chrome.counts.fail > 0}">
<td colspan="6"><div class="detailTitle">Mismatch Details</div>${mismatchDetails}</td>
</tr>`;
    }).join("\n");

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Velora WPT Comparison</title>
<style>
:root { --ink:#162016; --paper:#f7f1e3; --line:#d9cdae; --green:#1f8a4c; --red:#bb3e2f; --amber:#b97913; --blue:#2e5f9e; --muted:#6c6658; }
body { margin:0; font-family: Georgia, 'Times New Roman', serif; color:var(--ink); background:radial-gradient(circle at top left,#fff7d7,transparent 34rem),linear-gradient(135deg,#f7f1e3,#e8dcc1); }
header { padding:32px 36px 20px; border-bottom:1px solid var(--line); }
h1 { margin:0 0 8px; font-size:38px; letter-spacing:-.04em; }
.meta { color:var(--muted); }
.stats { display:flex; flex-wrap:wrap; gap:12px; padding:18px 36px; }
.card { background:rgba(255,255,255,.55); border:1px solid var(--line); border-radius:16px; padding:14px 16px; min-width:130px; box-shadow:0 10px 24px rgba(79,62,23,.08); }
.card b { display:block; font-size:24px; }
.controls { display:flex; gap:10px; flex-wrap:wrap; padding:0 36px 18px; }
button,input { border:1px solid var(--line); border-radius:999px; background:#fffaf0; color:var(--ink); padding:10px 14px; font:inherit; }
button.active { background:var(--ink); color:var(--paper); }
input { min-width:280px; }
.wrap { padding:0 24px 36px; overflow:auto; }
table { width:100%; border-collapse:separate; border-spacing:0; background:rgba(255,255,255,.72); border:1px solid var(--line); border-radius:18px; overflow:hidden; table-layout:fixed; }
th,td { text-align:left; vertical-align:top; padding:12px 14px; border-bottom:1px solid var(--line); }
th { position:sticky; top:0; background:#efe3c7; z-index:1; font-size:13px; text-transform:uppercase; letter-spacing:.08em; }
tr:last-child td { border-bottom:0; }
code { font-family:'SFMono-Regular',Consolas,monospace; font-size:12px; overflow-wrap:anywhere; }
.num { white-space:nowrap; font-variant-numeric:tabular-nums; }
.pill { display:inline-block; border-radius:999px; padding:4px 9px; font-size:12px; font-weight:700; }
.match,.auto { background:#dff2e5; color:var(--green); }
.mismatch { background:#ffe1dc; color:var(--red); }
.skipped_manual,.manual,.no_harness { background:#fff0c9; color:var(--amber); }
.error { background:#eadcff; color:#6946a3; }
.resultBox { min-width:0; }
.counts { display:grid; grid-template-columns:1fr 1fr; gap:5px; margin-bottom:8px; }
.count { border:1px solid var(--line); border-radius:10px; padding:5px 7px; background:#fffaf0; font-size:11px; font-weight:700; }
.count b { float:right; font-size:13px; }
.pass,.status.pass { color:var(--green); }
.fail,.status.fail { color:var(--red); }
.timeout,.status.timeout { color:var(--amber); }
.notrun,.status.notrun,.status.missing { color:var(--blue); }
.stack { display:flex; width:100%; height:10px; overflow:hidden; border-radius:999px; background:#eee1c5; box-shadow:inset 0 0 0 1px rgba(0,0,0,.08); }
.bar.pass { background:var(--green); }
.bar.fail { background:var(--red); }
.bar.timeout { background:var(--amber); }
.bar.notrun { background:var(--blue); }
.total { margin-top:5px; color:var(--muted); font-size:12px; }
.deltas { display:grid; grid-template-columns:1fr; gap:5px; margin-top:8px; min-width:0; }
.delta { border-radius:8px; padding:4px 6px; background:#fffaf0; border:1px solid var(--line); font-size:11px; font-weight:700; }
.delta.same { color:var(--muted); }
.delta.up { color:var(--red); }
.delta.down { color:var(--green); }
.bigMismatch { font-size:20px; font-weight:800; color:var(--red); }
.summaryRow td { border-bottom:0; }
.detailRow > td { padding:0 14px 18px; background:rgba(255,250,240,.55); border-bottom:2px solid var(--line); }
.detailTitle { display:inline-block; margin:0 0 8px; padding:5px 10px; background:var(--ink); color:var(--paper); border-radius:0 0 10px 10px; font-size:12px; font-weight:900; letter-spacing:.08em; text-transform:uppercase; }
.detailTable { width:100%; border-collapse:collapse; border:1px solid #1f1a10; border-radius:0; background:#fffef8; table-layout:fixed; }
.detailTable th,.detailTable td { border:1px solid #1f1a10; padding:8px 9px; vertical-align:top; overflow-wrap:anywhere; word-break:break-word; }
.detailTable th { position:static; background:#fff200; color:#15110a; text-align:center; font-size:12px; letter-spacing:.02em; }
.detailTable .idx { width:32px; text-align:center; font-weight:800; }
.detailTable .subtestName { width:32%; font-weight:700; line-height:1.35; }
.detailTable .message { color:var(--muted); font-size:12px; line-height:1.35; }
.status { display:inline-block; min-width:58px; text-align:center; border-radius:999px; border:1px solid currentColor; padding:3px 8px; font-weight:900; font-size:12px; }
.muted { color:var(--muted); font-size:12px; }
.hidden { display:none; }
@media (max-width: 760px) { header,.stats,.controls { padding-left:16px; padding-right:16px; } h1{font-size:30px;} input{min-width:100%;} th,td{padding:8px 7px;} .counts{grid-template-columns:1fr;} .detailTable th,.detailTable td{padding:6px 5px; font-size:11px;} }
</style>
</head>
<body>
<header>
<h1>Velora vs Chrome WPT</h1>
<div class="meta">Root: <code>${htmlEscape(report.root)}</code> · Generated: ${htmlEscape(report.generatedAt)} · Report: <code>${htmlEscape(report.reportPath)}</code></div>
</header>
<section class="stats">
<div class="card"><span>Total files</span><b>${totals.files}</b></div>
<div class="card"><span>Auto files</span><b>${totals.auto}</b></div>
<div class="card"><span>Manual/no harness</span><b>${totals.manual + totals.noHarness}</b></div>
<div class="card"><span>Mismatched files</span><b>${totals.mismatchedFiles}</b></div>
<div class="card"><span>Subtest mismatches</span><b>${totals.subtestMismatches}</b></div>
</section>
<section class="controls">
<input id="search" placeholder="Search test file or subtest...">
<button class="active" data-filter="all">All</button>
<button data-filter="mismatch">Mismatch only</button>
<button data-filter="veloraFail">Velora fail</button>
<button data-filter="chromeFail">Chrome fail</button>
<button data-filter="manual">Manual/no harness</button>
</section>
<div class="wrap">
<table>
<colgroup><col style="width:28%"><col style="width:8%"><col style="width:18%"><col style="width:18%"><col style="width:18%"><col style="width:10%"></colgroup>
<thead><tr><th>Test</th><th>Type</th><th>Chrome</th><th>Velora</th><th>Compare</th><th>Mismatches</th></tr></thead>
<tbody id="rows">${rows}</tbody>
</table>
</div>
<script>
const buttons = [...document.querySelectorAll('button[data-filter]')];
const search = document.getElementById('search');
let filter = 'all';
function applyFilter() {
  const q = search.value.toLowerCase();
  for (const tr of document.querySelectorAll('tbody tr')) {
    const text = tr.textContent.toLowerCase();
    const showSearch = !q || text.includes(q);
    const showFilter = filter === 'all'
      || (filter === 'mismatch' && tr.dataset.status === 'MISMATCH')
      || (filter === 'veloraFail' && tr.dataset.veloraFail === 'true')
      || (filter === 'chromeFail' && tr.dataset.chromeFail === 'true')
      || (filter === 'manual' && tr.dataset.type !== 'AUTO');
    tr.classList.toggle('hidden', !(showSearch && showFilter));
  }
}
buttons.forEach((button) => button.addEventListener('click', () => {
  buttons.forEach((item) => item.classList.remove('active'));
  button.classList.add('active');
  filter = button.dataset.filter;
  applyFilter();
}));
search.addEventListener('input', applyFilter);
</script>
</body>
</html>`;
    writeFileSync(path, html);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }
    if (!existsSync(veloraBin)) throw new Error(`Velora binary not found: ${veloraBin}. Run: zig build`);
    for (const dir of [tmpDir, outputDir, logDir, resolve(options.report, ".."), resolve(options.html, ".."), resolve(options.log, "..")]) ensureDir(dir);

    const tests = scanTests(options.root, options.includeManual, options.limit);
    if (tests.length === 0) throw new Error(`No WPT files found under ${options.root}`);

    const wptPort = await getFreePort(options.host);
    const veloraPort = await getFreePort(options.host);
    const staticServer = await startStaticServer(options.host, wptPort);
    const cdpEndpoint = `http://${options.host}:${veloraPort}`;
    const proc = spawn(veloraBin, [
        "serve", "--host", options.host, "--port", String(veloraPort),
        "--log-level", options.logLevel, "--log-format", options.logFormat,
        "--http-timeout", String(options.httpTimeoutMs),
    ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks = [];
    const stderrChunks = [];
    proc.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    let cdp;
    let browser;
    try {
        let chromium;
        try {
            ({ chromium } = require("playwright"));
        } catch (err) {
            throw new Error(`Playwright is required: ${err.message}`);
        }
        const diagnostics = createDiagnostics(options);
        proc.on("exit", (code, signal) => {
            diagnostics.processState.alive = false;
            const event = { code, signal, test: diagnostics.events.at(-1)?.test || null };
            diagnostics.processState.events.push(event);
            diagnostics.logEvent("PROCESS", "exit", event);
            if (event.test) diagnostics.processState.unexpectedDeathDuringTest = true;
        });
        proc.on("error", (err) => {
            diagnostics.processState.events.push({ error: err.message });
            diagnostics.logEvent("PROCESS", "error", { error: err.message });
        });
        await waitForServer(`${cdpEndpoint}/json/version`, options.serverTimeoutMs);
        cdp = await connectCDP(cdpEndpoint, options, diagnostics);
        setupCdpStateTracking(cdp);
        browser = await chromium.launch({ headless: true });

        const results = [];
        for (let index = 0; index < tests.length; index += 1) {
            const test = tests[index];
            const testUrl = `http://${options.host}:${wptPort}/${test.rel}`;
            if (cdp) cdp.diagnostics.setCurrentTest(test.rel);
            process.stdout.write(`[${index + 1}/${tests.length}] ${test.rel} (${test.type}) ... `);
            if (test.type !== "AUTO") {
                const empty = { status: { status: 3, message: "Manual/no harness test not executed" }, tests: [] };
                const item = {
                    test: test.rel,
                    url: testUrl,
                    type: test.type,
                    chrome: { ok: false, counts: summarize(empty), report: empty, error: "Skipped manual/no-harness test" },
                    velora: { ok: false, counts: summarize(empty), report: empty, error: "Skipped manual/no-harness test" },
                    comparison: { rows: [], mismatches: 0 },
                };
                results.push(item);
                console.log("skipped");
                continue;
            }
            const chromeRun = await runChromiumTest(browser, testUrl, options.testTimeoutMs);
            const veloraRun = await runVeloraTest(cdp, testUrl, options);
            const comparison = compareTestReports(chromeRun, veloraRun);
            const item = {
                test: test.rel,
                url: testUrl,
                type: test.type,
                chrome: { ...chromeRun, counts: summarize(chromeRun.report) },
                velora: { ...veloraRun, counts: summarize(veloraRun.report) },
                comparison,
            };
            results.push(item);
            console.log(comparison.mismatches === 0 ? "match" : `${comparison.mismatches} mismatch(es)`);
            if (options.failFast && comparison.mismatches > 0) {
                console.log("stopped early because --fail-fast is enabled");
                break;
            }
        }

        const totals = {
            files: results.length,
            auto: results.filter((item) => item.type === "AUTO").length,
            manual: results.filter((item) => item.type === "MANUAL").length,
            noHarness: results.filter((item) => item.type === "NO_HARNESS").length,
            mismatchedFiles: results.filter((item) => item.type === "AUTO" && item.comparison.mismatches > 0).length,
            subtestMismatches: results.reduce((sum, item) => sum + item.comparison.mismatches, 0),
        };
        const report = {
            generatedAt: new Date().toISOString(),
            root: options.root,
            limit: options.limit,
            includeManual: options.includeManual,
            reportPath: options.report,
            htmlPath: options.html,
            debugLifecycle: options.debugLifecycle,
            debugDir: options.debugLifecycle ? options.debugDir : undefined,
            diagnostics: cdp ? cdp.diagnostics.snapshot() : undefined,
            totals,
            results,
        };
        writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);
        writeHtmlReport(options.html, report);
        if (cdp) cdp.diagnostics.writeArtifacts();
        console.log(`saved JSON report: ${options.report}`);
        console.log(`saved HTML report: ${options.html}`);
        if (options.debugLifecycle) console.log(`saved debug lifecycle: ${options.debugDir}`);
        if (totals.mismatchedFiles > 0) process.exitCode = 1;
    } finally {
        if (browser) await browser.close().catch(() => undefined);
        if (cdp) { cdp.diagnostics.writeArtifacts(); cdp.close(); }
        await new Promise((resolvePromise) => staticServer.close(resolvePromise));
        await stopProcess(proc);
        writeFileSync(options.log, `--- VELORA STDOUT ---\n${Buffer.concat(stdoutChunks)}\n--- VELORA STDERR ---\n${Buffer.concat(stderrChunks)}\n`);
        console.log(`saved log: ${options.log}`);
    }
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
});
