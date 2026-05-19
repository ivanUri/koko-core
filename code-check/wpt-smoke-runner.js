#!/usr/bin/env node
// Run a small set of WPT testharness tests through Velora CDP.

const { spawn } = require("node:child_process");
const { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } = require("node:fs");
const { createServer: createHttpServer } = require("node:http");
const { createServer: createNetServer } = require("node:net");
const { extname, normalize, relative, resolve, sep } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const wptRoot = resolve(repoRoot, "wpt");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const tmpDir = resolve(repoRoot, "code-check/tmp");
const outputDir = resolve(tmpDir, "output");
const logDir = resolve(tmpDir, "logs");
const expectedPath = resolve(repoRoot, "code-check/wpt-expected.json");

const defaults = {
    host: "127.0.0.1",
    test: "wpt/html/dom/access-key-label.html",
    report: resolve(outputDir, "wpt-smoke-report.json"),
    compareReport: resolve(outputDir, "wpt-compare-report.json"),
    expected: expectedPath,
    log: resolve(logDir, "wpt-smoke-runner.log"),
    serverTimeoutMs: 3000,
    commandTimeoutMs: 15000,
    navigationTimeoutMs: 20000,
    testTimeoutMs: 20000,
    httpTimeoutMs: 30000,
    logLevel: "debug",
    logFormat: "pretty",
    mode: "expected",
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
    return `Usage: node code-check/wpt-smoke-runner.js [test-file] [options]

Examples:
  node code-check/wpt-smoke-runner.js
  node code-check/wpt-smoke-runner.js wpt/html/dom/access-key-label.html
  node code-check/wpt-smoke-runner.js wpt/html/dom/access-key-label.html --update-expected
  node code-check/wpt-smoke-runner.js wpt/html/dom/access-key-label.html --compare-browser

Options:
  --test <path>         WPT test file (default: ${defaults.test})
  --report <path>       JSON report path (default: ${defaults.report})
  --expected <path>     Expected baseline path (default: ${defaults.expected})
  --update-expected     Save current Velora result as the expected baseline
  --compare-browser     Compare Velora against Chromium through Playwright
  --compare-report <p>  JSON compare report path (default: ${defaults.compareReport})
  --log <path>          Velora log path (default: ${defaults.log})
  --timeout <ms>        Test completion timeout (default: ${defaults.testTimeoutMs})
  --log-level <level>   Velora log level (default: ${defaults.logLevel})
  --help                Show this help
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
            case "--test": options.test = next(); break;
            case "--report": options.report = resolve(next()); break;
            case "--compare-report": options.compareReport = resolve(next()); break;
            case "--expected": options.expected = resolve(next()); break;
            case "--update-expected": options.updateExpected = true; break;
            case "--compare-browser": options.compareBrowser = true; break;
            case "--log": options.log = resolve(next()); break;
            case "--timeout": options.testTimeoutMs = Number(next()); break;
            case "--log-level": options.logLevel = next(); break;
            case "--help":
            case "-h": options.help = true; break;
            default:
                if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
                options.test = arg;
        }
    }
    for (const key of ["serverTimeoutMs", "commandTimeoutMs", "navigationTimeoutMs", "testTimeoutMs", "httpTimeoutMs"]) {
        if (!Number.isFinite(options[key]) || options[key] < 0) throw new Error(`Invalid ${key}: ${options[key]}`);
    }
    return options;
}

function delay(ms) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
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
        await delay(100);
    }
    throw new Error(`Timed out waiting for ${url}`);
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
                            status,
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

async function connectCDP(cdpEndpoint, options) {
    const versionRes = await fetch(`${cdpEndpoint}/json/version`);
    if (!versionRes.ok) throw new Error(`Unable to read CDP version: HTTP ${versionRes.status}`);
    const { webSocketDebuggerUrl } = await versionRes.json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    const callbacks = new Map();
    let nextId = 1;
    let closed = false;

    function rejectPending(err) {
        for (const [id, callback] of callbacks) {
            if (callback.timer) clearTimeout(callback.timer);
            callback.reject(err);
            callbacks.delete(id);
        }
    }

    ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id == null || !callbacks.has(message.id)) return;
        const callback = callbacks.get(message.id);
        callbacks.delete(message.id);
        if (callback.timer) clearTimeout(callback.timer);
        if (message.error) callback.reject(new Error(`${callback.method}: ${message.error.message} (${message.error.code})`));
        else callback.resolve(message.result || {});
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
            if (closed || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(`Cannot send ${method}: CDP websocket is not open`));
            const id = nextId++;
            const payload = { id, method, params };
            if (sessionId) payload.sessionId = sessionId;
            return new Promise((resolvePromise, reject) => {
                const timer = timeoutMs ? setTimeout(() => {
                    callbacks.delete(id);
                    reject(new Error(`${method} timed out after ${timeoutMs}ms`));
                }, timeoutMs) : null;
                callbacks.set(id, { method, resolve: resolvePromise, reject, timer });
                ws.send(JSON.stringify(payload));
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
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId, timeoutMs);
    if (result.exceptionDetails) throw new Error(`Runtime.evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
    return result.result ? result.result.value : undefined;
}

async function navigate(cdp, sessionId, url, timeoutMs) {
    await cdp.send("Page.navigate", { url }, sessionId, timeoutMs);
    await delay(250);
}

async function collectWptResults(cdp, sessionId, timeoutMs) {
    const installExpression = `(() => {
        const serialize = (tests, status) => ({
            status,
            tests: (tests || []).map((test) => ({
                name: test.name,
                status: test.status,
                message: test.message || '',
                stack: test.stack || ''
            }))
        });
        if (window.__veloraWptDone || window.__veloraWptInstalled) return true;
        if (typeof add_completion_callback === 'function') {
            window.__veloraWptInstalled = true;
            add_completion_callback((tests, status) => {
                window.__veloraWptDone = serialize(tests, status);
            });
            return true;
        }
        window.__veloraWptDone = { status: { status: 2, message: 'testharness add_completion_callback is not available' }, tests: [] };
        return false;
    })()`;
    await evaluate(cdp, sessionId, installExpression, Math.min(timeoutMs, 5000));

    const readExpression = `(() => window.__veloraWptDone || null)()`;
    const started = Date.now();
    while (Date.now() - started <= timeoutMs) {
        const report = await evaluate(cdp, sessionId, readExpression, Math.min(timeoutMs, 1000));
        if (report) return report;
        await delay(100);
    }
    const fallbackExpression = `(() => {
        if (window.__veloraWptResults && window.__veloraWptResults.length > 0) {
            return {
                status: { status: 2, message: 'WPT harness did not complete; using collected result callbacks' },
                tests: window.__veloraWptResults
            };
        }
        const internal = window.tests;
        const list = internal && internal.tests ? Array.prototype.slice.call(internal.tests) : [];
        return {
            status: internal && internal.status ? {
                status: internal.status.status,
                message: internal.status.message || 'WPT harness did not complete',
                stack: internal.status.stack || ''
            } : { status: 2, message: 'WPT harness did not expose internal tests object' },
            tests: list.map((test) => ({
                name: test.name,
                status: test.status,
                message: test.message || '',
                stack: test.stack || ''
            }))
        };
    })()`;
    const fallback = await evaluate(cdp, sessionId, fallbackExpression, Math.min(timeoutMs, 1000));
    if (fallback && fallback.tests && fallback.tests.length > 0) return fallback;
    return { status: { status: 2, message: `Timed out waiting for WPT completion after ${timeoutMs}ms` }, tests: [] };
}

function summarize(report) {
    const tests = report.tests || [];
    const counts = { total: tests.length, pass: 0, fail: 0, timeout: 0, notrun: 0 };
    for (const test of tests) {
        if (test.status === 0) counts.pass += 1;
        else if (test.status === 1) counts.fail += 1;
        else if (test.status === 2) counts.timeout += 1;
        else counts.notrun += 1;
    }
    return counts;
}

function statusName(status) {
    return statusNames[status] || "NOTRUN";
}

function testsToExpectation(report) {
    const expected = {};
    for (const test of report.tests || []) expected[test.name] = statusName(test.status);
    return expected;
}

function readJsonFile(path, fallback) {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonFile(path, value) {
    const dir = resolve(path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function compareWithExpected(testRel, report, expectedRoot) {
    const expected = expectedRoot[testRel] || {};
    const actual = testsToExpectation(report);
    const names = Array.from(new Set([...Object.keys(expected), ...Object.keys(actual)])).sort();
    const rows = names.map((name) => {
        const expectedStatus = expected[name] || "MISSING";
        const actualStatus = actual[name] || "MISSING";
        let result = "OK";
        if (expectedStatus === "MISSING") result = "NEW";
        else if (actualStatus === "MISSING") result = "MISSING";
        else if (expectedStatus !== actualStatus) result = expectedStatus === "FAIL" && actualStatus === "PASS" ? "PROGRESS" : "REGRESSION";
        return { name, expected: expectedStatus, actual: actualStatus, result };
    });
    const ok = rows.length > 0 && rows.every((row) => row.result === "OK" || row.result === "PROGRESS");
    return { ok, rows };
}

function printExpectedComparison(comparison) {
    console.log("\nWPT expected comparison:");
    for (const row of comparison.rows) {
        console.log(`${row.result.padEnd(10)} expected=${row.expected.padEnd(8)} actual=${row.actual.padEnd(8)} ${row.name}`);
    }
}

async function runChromiumWpt(testUrl, timeoutMs) {
    let chromium;
    try {
        ({ chromium } = require("playwright"));
    } catch (err) {
        throw new Error(`Playwright is required for --compare-browser: ${err.message}`);
    }
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.goto(testUrl, { waitUntil: "load", timeout: timeoutMs });
        const report = await page.waitForFunction(() => window.__veloraWptDone || null, null, { timeout: timeoutMs }).then((handle) => handle.jsonValue());
        return report;
    } finally {
        await browser.close();
    }
}

function compareReports(referenceReport, veloraReport) {
    const reference = testsToExpectation(referenceReport);
    const velora = testsToExpectation(veloraReport);
    const names = Array.from(new Set([...Object.keys(reference), ...Object.keys(velora)])).sort();
    const rows = names.map((name) => {
        const browser = reference[name] || "MISSING";
        const actual = velora[name] || "MISSING";
        return { name, browser, velora: actual, result: browser === actual ? "OK" : "MISMATCH" };
    });
    return { ok: rows.length > 0 && rows.every((row) => row.result === "OK"), rows };
}

function printBrowserComparison(comparison) {
    console.log("\nWPT Chromium comparison:");
    for (const row of comparison.rows) {
        console.log(`${row.result.padEnd(10)} chromium=${row.browser.padEnd(8)} velora=${row.velora.padEnd(8)} ${row.name}`);
    }
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }
    if (!existsSync(veloraBin)) throw new Error(`Velora binary not found: ${veloraBin}. Run: zig build`);
    for (const dir of [tmpDir, outputDir, logDir, resolve(options.report, ".."), resolve(options.compareReport, ".."), resolve(options.log, "..")]) {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    const wptPort = await getFreePort(options.host);
    const veloraPort = await getFreePort(options.host);
    const staticServer = await startStaticServer(options.host, wptPort);
    const cdpEndpoint = `http://${options.host}:${veloraPort}`;
    const testRel = toWptRelativePath(options.test);
    const testUrl = `http://${options.host}:${wptPort}/${testRel}`;

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
    let targetId;
    try {
        await waitForServer(`${cdpEndpoint}/json/version`, options.serverTimeoutMs);
        cdp = await connectCDP(cdpEndpoint, options);
        const page = await createPageSession(cdp);
        targetId = page.targetId;
        await cdp.send("Runtime.enable", {}, page.sessionId);
        await cdp.send("Page.enable", {}, page.sessionId);

        console.log(`[wpt] ${testUrl}`);
        await navigate(cdp, page.sessionId, testUrl, options.navigationTimeoutMs);
        const wptReport = await collectWptResults(cdp, page.sessionId, options.testTimeoutMs);
        const counts = summarize(wptReport);
        const rawPassed = counts.total > 0 && counts.fail === 0 && counts.timeout === 0 && counts.notrun === 0;
        const result = { passed: rawPassed, test: testRel, url: testUrl, counts, report: wptReport };

        if (options.updateExpected) {
            const expectedRoot = readJsonFile(options.expected, {});
            expectedRoot[testRel] = testsToExpectation(wptReport);
            writeJsonFile(options.expected, expectedRoot);
            console.log(`updated expected baseline: ${options.expected}`);
        }

        if (!options.updateExpected) {
            const expectedRoot = readJsonFile(options.expected, {});
            const expectedComparison = compareWithExpected(testRel, wptReport, expectedRoot);
            result.expected = { path: options.expected, ...expectedComparison };
            result.passed = expectedComparison.ok;
            printExpectedComparison(expectedComparison);
            if (!expectedRoot[testRel]) console.log(`no baseline for ${testRel}; run with --update-expected after reviewing this result`);
        }

        if (options.compareBrowser) {
            const chromiumReport = await runChromiumWpt(testUrl, options.testTimeoutMs);
            const browserComparison = compareReports(chromiumReport, wptReport);
            result.browserComparison = { browser: "chromium", ...browserComparison, report: chromiumReport };
            printBrowserComparison(browserComparison);
            writeJsonFile(options.compareReport, result.browserComparison);
            console.log(`saved compare report: ${options.compareReport}`);
            result.passed = result.passed && browserComparison.ok;
        }

        writeJsonFile(options.report, result);
        console.log(JSON.stringify(result, null, 2));
        console.log(`saved report: ${options.report}`);
        if (!result.passed) process.exitCode = 1;
    } finally {
        if (cdp && targetId) await cdp.send("Target.closeTarget", { targetId }, undefined, options.commandTimeoutMs).catch(() => undefined);
        if (cdp) cdp.close();
        await new Promise((resolvePromise) => staticServer.close(resolvePromise));
        const procExited = proc.exitCode != null || proc.signalCode != null ? Promise.resolve() : new Promise((resolvePromise) => proc.once("exit", resolvePromise));
        if (proc.exitCode == null && !proc.killed) proc.kill("SIGTERM");
        await procExited;
        writeFileSync(options.log, `--- VELORA STDOUT ---\n${Buffer.concat(stdoutChunks)}\n--- VELORA STDERR ---\n${Buffer.concat(stderrChunks)}\n`);
        console.log(`saved log: ${options.log}`);
    }
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
});
