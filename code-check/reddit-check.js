#!/usr/bin/env node
// Benchmark Wikipedia pages through Velora CDP and expose basic page content.
// Usage:
//   node code-check/reddit-check.js
//   node code-check/reddit-check.js --url https://en.wikipedia.org/wiki/JavaScript
//   node code-check/reddit-check.js --count 100 --concurrency 10

const { spawn } = require("node:child_process");
const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const tmpDir = resolve(repoRoot, "code-check/tmp");
const outputDir = resolve(tmpDir, "output");
const logDir = resolve(tmpDir, "logs");

const wikipediaPages = [
    "Main_Page", "Vietnam", "Ho_Chi_Minh_City", "Hanoi", "Da_Nang", "Southeast_Asia", "Asia", "Earth", "Moon", "Sun",
    "Solar_System", "Milky_Way", "Universe", "Physics", "Chemistry", "Biology", "Mathematics", "Computer_science", "Software", "Internet",
    "World_Wide_Web", "JavaScript", "HTML", "CSS", "Node.js", "Zig_(programming_language)", "C_(programming_language)", "Python_(programming_language)", "Rust_(programming_language)", "Go_(programming_language)",
    "Artificial_intelligence", "Machine_learning", "Deep_learning", "Natural_language_processing", "Computer_vision", "Database", "PostgreSQL", "Redis", "Linux", "Unix",
    "macOS", "Google_Chrome", "WebSocket", "Hypertext_Transfer_Protocol", "Transport_Layer_Security", "Domain_Name_System", "URL", "Unicode", "UTF-8", "JSON",
    "Wikipedia", "Wikimedia_Foundation", "Open-source_software", "Free_software", "Git", "GitHub", "Docker_(software)", "Kubernetes", "Cloud_computing", "Amazon_Web_Services",
    "Google_Cloud_Platform", "Microsoft_Azure", "Algorithm", "Data_structure", "Binary_tree", "Hash_table", "Sorting_algorithm", "Search_algorithm", "Graph_theory", "Compiler",
    "Interpreter_(computing)", "Operating_system", "Process_(computing)", "Thread_(computing)", "Concurrency_(computer_science)", "Parallel_computing", "Memory_management", "Garbage_collection_(computer_science)", "Pointer_(computer_programming)", "Application_programming_interface",
    "Representational_state_transfer", "Microservices", "Web_browser", "Document_Object_Model", "Cascading_Style_Sheets", "ECMAScript", "TypeScript", "React_(software)", "Vue.js", "Svelte",
    "History_of_Vietnam", "Nguyen_dynasty", "French_Indochina", "Vietnam_War", "Mekong", "Red_River_(Asia)", "Pho", "Coffee", "Tea", "Rice",
];

const defaultWikipediaUrls = wikipediaPages.map((page) => `https://en.wikipedia.org/wiki/${page}`);

const exportConfig = {
    removeScripts: true,
    rewriteRenderResourceUrls: true,
    waitStrategy: "auto",
    minWaitMs: 0,
    quietWindowMs: 500,
    maxAutoWaitMs: 5000,
    pollIntervalMs: 150,
};

const defaults = {
    url: "https://www.wikipedia.org/",
    batch: true,
    count: 100,
    concurrency: 10,
    host: "127.0.0.1",
    waitMs: null,
    minWaitMs: exportConfig.minWaitMs,
    quietWindowMs: exportConfig.quietWindowMs,
    maxAutoWaitMs: exportConfig.maxAutoWaitMs,
    pollIntervalMs: exportConfig.pollIntervalMs,
    serverTimeoutMs: 15000,
    commandTimeoutMs: 15000,
    navigationTimeoutMs: 20000,
    output: resolve(outputDir, "wikipedia-batch"),
    report: resolve(outputDir, "wikipedia-batch.report.json"),
    log: resolve(logDir, "wikipedia-batch.log"),
    httpTimeoutMs: 30000,
    logLevel: "debug",
    logFormat: "pretty",
};

function usage() {
    return `Usage: node code-check/reddit-check.js [options]

Options:
  --url <url>          URL to open (default: ${defaults.url})
  --single             Run one URL only; default runs 100 Wikipedia URLs
  --count <n>          Number of Wikipedia URLs for batch mode (default: ${defaults.count})
  --concurrency <n>    Parallel page sessions in batch mode (default: ${defaults.concurrency})
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
                options.batch = false;
                break;
            case "--single":
                options.batch = false;
                break;
            case "--count":
                options.count = Number(next());
                break;
            case "--concurrency":
                options.concurrency = Number(next());
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

    for (const key of ["serverTimeoutMs", "commandTimeoutMs", "navigationTimeoutMs", "httpTimeoutMs", "minWaitMs", "quietWindowMs", "maxAutoWaitMs", "pollIntervalMs", "count", "concurrency"]) {
        if (!Number.isFinite(options[key]) || options[key] < 0) {
            throw new Error(`Invalid numeric option ${key}: ${options[key]}`);
        }
    }
    if (options.batch && options.concurrency < 1) throw new Error("--concurrency must be at least 1");
    if (options.batch && options.count < 1) throw new Error("--count must be at least 1");
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

function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[index];
}

function getTargetUrls(options) {
    if (!options.batch) return [options.url];
    const urls = [];
    for (let i = 0; i < options.count; i += 1) {
        urls.push(defaultWikipediaUrls[i % defaultWikipediaUrls.length]);
    }
    return urls;
}

async function runWithConcurrency(items, concurrency, worker) {
    const results = new Array(items.length);
    let nextIndex = 0;

    async function runWorker() {
        while (nextIndex < items.length) {
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await worker(items[index], index);
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, runWorker);
    await Promise.all(workers);
    return results;
}

function startVelora(options, port) {
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

    return { proc, stdoutChunks, stderrChunks };
}

async function stopVelora(worker) {
    const procExited = worker.proc.exitCode != null || worker.proc.signalCode != null
        ? Promise.resolve()
        : new Promise((resolvePromise) => worker.proc.once("exit", resolvePromise));
    if (worker.proc.exitCode == null && !worker.proc.killed) worker.proc.kill("SIGTERM");
    await procExited;
}

function workerLogPath(logPath, workerIndex) {
    if (workerIndex === 0) return logPath;
    return logPath.replace(/(\.[^./]+)?$/, `.worker-${workerIndex + 1}$1`);
}

async function writeWorkerLog(worker, options) {
    const logPath = workerLogPath(options.log, worker.index);
    const stdout = Buffer.concat(worker.stdoutChunks).toString();
    const stderr = Buffer.concat(worker.stderrChunks).toString();
    writeFileSync(logPath, "");
    appendSection(logPath, "VELORA STDOUT", stdout);
    appendSection(logPath, "VELORA STDERR", stderr);
    console.log(`saved log: ${logPath}`);
}

async function createWorker(options, index) {
    const port = await getFreePort(options.host);
    const endpoint = `http://${options.host}:${port}`;
    const worker = { index, port, endpoint, cdp: null, ...startVelora(options, port) };
    await waitForServer(`${endpoint}/json/version`, options.serverTimeoutMs);
    worker.cdp = await connectCDP(endpoint, options);
    return worker;
}

async function runPageCheck(cdp, options, url, index) {
    let targetId;
    let sessionId;
    const startedAt = Date.now();
    try {
        ({ targetId, sessionId } = await createPageSession(cdp));
        await cdp.send("Runtime.enable", {}, sessionId);
        await cdp.send("Page.enable", {}, sessionId);
        await cdp.send("Network.enable", {}, sessionId).catch(() => undefined);

        console.log(`[${index + 1}] navigate ${url}`);
        const navigationStartedAt = Date.now();
        await navigate(cdp, sessionId, url, options.navigationTimeoutMs);
        const navigationMs = Date.now() - navigationStartedAt;
        const settle = await waitForPageStable(cdp, sessionId, options);

        const pageReport = await evaluate(cdp, sessionId, `(() => {
            ${createPageTestRecorder.toString()}
            ${testPage.toString()}
            ${inspectPage.toString()}
            return inspectPage();
        })()`, options.commandTimeoutMs);
        const result = validatePage(pageReport);
        result.url = url;
        result.index = index;
        result.timing = {
            navigationMs,
            settleWaitMs: settle.waitMs,
            totalMs: Date.now() - startedAt,
            settledReason: settle.reason,
            waitStrategy: settle.strategy,
        };

        if (!options.batch) {
            const html = await getPageContent(cdp, sessionId, options.commandTimeoutMs, pageReport.url || url);
            writeFileSync(options.output, html);
            result.output = options.output;
        } else {
            result.output = null;
        }

        console.log(`[${index + 1}] ${result.passed ? "PASS" : "FAIL"} ${url} total=${result.timing.totalMs}ms nav=${navigationMs}ms`);
        return result;
    } catch (err) {
        const result = {
            url,
            index,
            passed: false,
            error: {
                name: err?.name || "Error",
                message: err?.message || String(err),
                stack: err?.stack || null,
            },
            timing: { totalMs: Date.now() - startedAt },
        };
        console.warn(`[${index + 1}] ERROR ${url}: ${result.error.message}`);
        return result;
    } finally {
        if (targetId) {
            await cdp.send("Target.closeTarget", { targetId }, undefined, options.commandTimeoutMs).catch(() => undefined);
        }
    }
}

async function runPageCheckOnWorker(worker, options, item) {
    return runPageCheck(worker.cdp, options, item.url, item.index);
}

function distributeItems(items, concurrency) {
    const workerCount = Math.min(concurrency, items.length);
    const buckets = Array.from({ length: workerCount }, () => []);
    for (let i = 0; i < items.length; i += 1) buckets[i % workerCount].push(items[i]);
    return buckets;
}

async function runBatchWithWorkers(urls, options) {
    const items = urls.map((url, index) => ({ url, index }));
    const buckets = distributeItems(items, options.batch ? options.concurrency : 1);
    const results = new Array(items.length);
    const workers = [];

    try {
        for (let i = 0; i < buckets.length; i += 1) {
            workers.push(await createWorker(options, i));
            console.log(`[worker:${i + 1}] started ${workers[i].endpoint} jobs=${buckets[i].length}`);
        }

        await Promise.all(workers.map(async (worker, workerIndex) => {
            for (const item of buckets[workerIndex]) {
                results[item.index] = await runPageCheckOnWorker(worker, options, item);
            }
        }));

        return { results, workers };
    } catch (err) {
        for (const item of items) {
            if (!results[item.index]) {
                results[item.index] = {
                    url: item.url,
                    index: item.index,
                    passed: false,
                    error: {
                        name: err?.name || "Error",
                        message: err?.message || String(err),
                        stack: err?.stack || null,
                    },
                    timing: { totalMs: 0 },
                };
            }
        }
        return { results, workers };
    }
}

function summarizeResults(results, startedAt, options) {
    const passed = results.filter((item) => item?.passed).length;
    const failed = results.length - passed;
    const timings = results.map((item) => item?.timing?.totalMs).filter((value) => Number.isFinite(value));
    const navigationTimings = results.map((item) => item?.timing?.navigationMs).filter((value) => Number.isFinite(value));

    return {
        passed: failed === 0,
        summary: {
            total: results.length,
            passed,
            failed,
            concurrency: options.batch ? options.concurrency : 1,
            totalWallMs: Date.now() - startedAt,
            totalMs: {
                min: timings.length ? Math.min(...timings) : null,
                max: timings.length ? Math.max(...timings) : null,
                avg: timings.length ? Math.round(timings.reduce((sum, value) => sum + value, 0) / timings.length) : null,
                p50: percentile(timings, 50),
                p95: percentile(timings, 95),
            },
            navigationMs: {
                min: navigationTimings.length ? Math.min(...navigationTimings) : null,
                max: navigationTimings.length ? Math.max(...navigationTimings) : null,
                avg: navigationTimings.length ? Math.round(navigationTimings.reduce((sum, value) => sum + value, 0) / navigationTimings.length) : null,
                p50: percentile(navigationTimings, 50),
                p95: percentile(navigationTimings, 95),
            },
        },
        results,
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

    let workers = [];
    try {
        const startedAt = Date.now();
        const urls = getTargetUrls(options);
        console.log(`[benchmark] urls=${urls.length} concurrency=${options.batch ? options.concurrency : 1}`);
        const run = await runBatchWithWorkers(urls, options);
        workers = run.workers;
        const results = run.results;
        const report = summarizeResults(results, startedAt, options);

        writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`);

        console.log(JSON.stringify(report.summary, null, 2));
        if (!options.batch && results[0]?.output) console.log(`saved html: ${results[0].output}`);
        console.log(`saved report: ${options.report}`);

        if (!report.passed) {
            console.warn("one or more page checks failed; see report for details");
            process.exitCode = 1;
        }
    } finally {
        console.log("[cleanup] closing CDP and Velora workers");
        for (const worker of workers) {
            if (worker.cdp) worker.cdp.close();
        }
        for (const worker of workers) {
            await stopVelora(worker).catch(() => undefined);
            await writeWorkerLog(worker, options).catch(() => undefined);
        }
    }
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
});
