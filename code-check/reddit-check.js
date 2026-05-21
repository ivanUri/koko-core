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

const exportConfig = {
    removeScripts: true,
    rewriteRenderResourceUrls: true,
    waitStrategy: "auto",
    minWaitMs: 20000,
    quietWindowMs: 500,
    maxAutoWaitMs: 5000,
    pollIntervalMs: 150,
};

const defaults = {
    url: "https://abrahamjuliot.github.io/creepjs/",
    host: "127.0.0.1",
    waitMs: null,
    minWaitMs: exportConfig.minWaitMs,
    quietWindowMs: exportConfig.quietWindowMs,
    maxAutoWaitMs: exportConfig.maxAutoWaitMs,
    pollIntervalMs: exportConfig.pollIntervalMs,
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
  --wait-ms <ms>       Fixed wait after navigation; disables auto wait (default: auto)
  --min-wait-ms <ms>   Minimum auto wait after navigation (default: ${defaults.minWaitMs})
  --quiet-ms <ms>      DOM/content must stay stable for this long (default: ${defaults.quietWindowMs})
  --max-wait-ms <ms>   Maximum auto wait after navigation (default: ${defaults.maxAutoWaitMs})
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
            case "--min-wait-ms":
                options.minWaitMs = Number(next());
                break;
            case "--quiet-ms":
                options.quietWindowMs = Number(next());
                break;
            case "--max-wait-ms":
                options.maxAutoWaitMs = Number(next());
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

    for (const key of ["serverTimeoutMs", "commandTimeoutMs", "navigationTimeoutMs", "httpTimeoutMs", "minWaitMs", "quietWindowMs", "maxAutoWaitMs", "pollIntervalMs"]) {
        if (!Number.isFinite(options[key]) || options[key] < 0) {
            throw new Error(`Invalid numeric option ${key}: ${options[key]}`);
        }
    }
    if (options.waitMs != null && (!Number.isFinite(options.waitMs) || options.waitMs < 0)) {
        throw new Error(`Invalid numeric option waitMs: ${options.waitMs}`);
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
    const payload = JSON.stringify({ ...exportConfig, pageUrl });
    const html = await evaluate(cdp, sessionId, `(() => {
        const config = ${payload};
        const root = document.documentElement ? document.documentElement.cloneNode(true) : null;
        const baseUrl = config.pageUrl || document.baseURI || location.href;

        function canResolveUrl(value) {
            if (!value) return false;
            const trimmed = String(value).trim();
            if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return false;
            if (/^(?:[a-z][a-z0-9+.-]*:)/i.test(trimmed)) return false;
            return true;
        }

        function resolveUrl(value) {
            if (!canResolveUrl(value)) return value;
            try {
                return new URL(value, baseUrl).href;
            } catch (_) {
                return value;
            }
        }

        function rewriteSrcset(value) {
            return String(value).split(",").map((item) => {
                const trimmed = item.trim();
                if (!trimmed) return item;
                const parts = trimmed.split(/\s+/);
                parts[0] = resolveUrl(parts[0]);
                return parts.join(" ");
            }).join(", ");
        }

        function relTokens(el) {
            return new Set((el.getAttribute("rel") || "").toLowerCase().split(/\s+/).filter(Boolean));
        }

        function shouldRewriteLinkHref(el) {
            const rel = relTokens(el);
            const asValue = (el.getAttribute("as") || "").toLowerCase();
            if (rel.has("modulepreload")) return false;
            if ((rel.has("preload") || rel.has("prefetch")) && asValue === "script") return false;
            return true;
        }

        function rewriteAttr(selector, attr) {
            if (!root) return;
            for (const el of root.querySelectorAll(selector)) {
                const value = el.getAttribute(attr);
                if (value) el.setAttribute(attr, resolveUrl(value));
            }
        }

        if (config.removeScripts) {
            for (const el of root ? root.querySelectorAll("script") : []) el.remove();
        }

        if (config.rewriteRenderResourceUrls) {
            for (const el of root ? root.querySelectorAll("base") : []) el.remove();
            for (const el of root ? root.querySelectorAll("link[href]") : []) {
                if (shouldRewriteLinkHref(el)) el.setAttribute("href", resolveUrl(el.getAttribute("href")));
            }

            rewriteAttr("img[src]", "src");
            rewriteAttr("source[src]", "src");
            rewriteAttr("video[src]", "src");
            rewriteAttr("video[poster]", "poster");
            rewriteAttr("audio[src]", "src");
            rewriteAttr("track[src]", "src");
            rewriteAttr("embed[src]", "src");
            rewriteAttr("iframe[src]", "src");
            rewriteAttr("object[data]", "data");

            for (const el of root ? root.querySelectorAll("img[srcset], source[srcset]") : []) {
                el.setAttribute("srcset", rewriteSrcset(el.getAttribute("srcset")));
            }
        }

        return root ? root.outerHTML : "";
    })()`, timeoutMs);
    return `<!DOCTYPE html>\n${html || ""}`;
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

async function getPageStability(cdp, sessionId, timeoutMs) {
    return evaluate(cdp, sessionId, `(() => {
        const bodyText = document.body ? (document.body.innerText || document.body.textContent || "") : "";
        return {
            readyState: document.readyState,
            title: document.title || "",
            textLength: bodyText.trim().length,
            bodyChildCount: document.body ? document.body.children.length : 0,
            nodeCount: document.querySelectorAll("*").length,
        };
    })()`, timeoutMs);
}

function stabilitySignature(state) {
    return JSON.stringify({
        readyState: state.readyState,
        title: state.title,
        textLength: state.textLength,
        bodyChildCount: state.bodyChildCount,
        nodeCount: state.nodeCount,
    });
}

async function waitForPageStable(cdp, sessionId, options) {
    const started = Date.now();
    if (options.waitMs != null) {
        console.log(`[wait:fixed] ${options.waitMs}ms`);
        await delay(options.waitMs);
        return { strategy: "fixed", reason: "fixed-wait", waitMs: Date.now() - started };
    }

    console.log(`[wait:auto] quiet=${options.quietWindowMs}ms max=${options.maxAutoWaitMs}ms`);
    let lastSignature = "";
    let stableSince = Date.now();
    let lastState = null;

    while (Date.now() - started <= options.maxAutoWaitMs) {
        lastState = await getPageStability(cdp, sessionId, options.commandTimeoutMs);
        const signature = stabilitySignature(lastState);
        if (signature !== lastSignature) {
            lastSignature = signature;
            stableSince = Date.now();
        }

        const elapsed = Date.now() - started;
        const stableMs = Date.now() - stableSince;
        const ready = lastState.readyState === "interactive" || lastState.readyState === "complete";
        const hasContent = lastState.textLength > 0 || lastState.bodyChildCount > 0;
        if (elapsed >= options.minWaitMs && ready && hasContent && stableMs >= options.quietWindowMs) {
            return { strategy: "auto", reason: "stable", waitMs: elapsed, stableMs, state: lastState };
        }

        await delay(Math.max(25, options.pollIntervalMs));
    }

    return {
        strategy: "auto",
        reason: "timeout",
        waitMs: Date.now() - started,
        stableMs: Date.now() - stableSince,
        state: lastState,
    };
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

        const startedAt = Date.now();
        console.log(`[navigate:cdp] ${options.url}`);
        const navigationStartedAt = Date.now();
        await navigate(cdp, sessionId, options.url, options.navigationTimeoutMs);
        const navigationMs = Date.now() - navigationStartedAt;
        const settle = await waitForPageStable(cdp, sessionId, options);

        console.log("[inspect] collecting page report");
        const pageReport = await evaluate(cdp, sessionId, `(() => {
            ${createPageTestRecorder.toString()}
            ${testPage.toString()}
            ${inspectPage.toString()}
            return inspectPage();
        })()`, options.commandTimeoutMs);
        const result = validatePage(pageReport);
        result.timing = {
            navigationMs,
            settleWaitMs: settle.waitMs,
            totalMs: Date.now() - startedAt,
            settledReason: settle.reason,
            waitStrategy: settle.strategy,
        };
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
