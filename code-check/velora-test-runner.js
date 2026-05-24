#!/usr/bin/env node
// Benchmark velora-test pages on Velora and Chromium.

const { spawn } = require("node:child_process");
const { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { createServer: createHttpServer } = require("node:http");
const { createServer: createNetServer } = require("node:net");
const { extname, normalize, relative, resolve, sep } = require("node:path");
const { performance } = require("node:perf_hooks");

const repoRoot = resolve(__dirname, "..");
const testRoot = resolve(repoRoot, "velora-test");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const tmpDir = resolve(repoRoot, "code-check/tmp");
const outputDir = resolve(tmpDir, "output");
const logDir = resolve(tmpDir, "logs");

const defaults = {
    host: "127.0.0.1",
    report: resolve(outputDir, "velora-test-benchmark.json"),
    log: resolve(logDir, "velora-test-benchmark.log"),
    repeats: 3,
    warmup: 1,
    timeoutMs: 10000,
    serverTimeoutMs: 3000,
    commandTimeoutMs: 15000,
    settleMs: 0,
    httpTimeoutMs: 30000,
    logLevel: "warn",
    logFormat: "pretty",
};

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
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
};

function usage() {
    return `Usage: npm run test:velora -- [paths...] [options]

Benchmarks HTML files in velora-test with Velora and Chromium.

Examples:
  npm run test:velora
  npm run test:velora -- index.html ua.html
  npm run test:velora -- amiibo --repeats 5 --warmup 2

Options:
  --report <path>       JSON report path (default: ${defaults.report})
  --log <path>          Velora log path (default: ${defaults.log})
  --repeats <n>         Measured iterations per page/browser (default: ${defaults.repeats})
  --warmup <n>          Warmup iterations before measuring (default: ${defaults.warmup})
  --timeout <ms>        Timeout per navigation (default: ${defaults.timeoutMs})
  --log-level <level>   Velora log level (default: ${defaults.logLevel})
  --help                Show this help
`;
}

function parseArgs(argv) {
    const options = { ...defaults, paths: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
            i += 1;
            return argv[i];
        };
        switch (arg) {
            case "--report": options.report = resolve(next()); break;
            case "--log": options.log = resolve(next()); break;
            case "--repeats": options.repeats = Number(next()); break;
            case "--warmup": options.warmup = Number(next()); break;
            case "--timeout": options.timeoutMs = Number(next()); break;
            case "--log-level": options.logLevel = next(); break;
            case "--help":
            case "-h": options.help = true; break;
            default:
                if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
                options.paths.push(arg);
        }
    }
    for (const key of ["repeats", "warmup", "timeoutMs", "serverTimeoutMs", "commandTimeoutMs", "httpTimeoutMs"]) {
        if (!Number.isFinite(options[key]) || options[key] < 0) throw new Error(`Invalid ${key}: ${options[key]}`);
    }
    if (options.repeats < 1) throw new Error("--repeats must be >= 1");
    return options;
}

function delay(ms) { return new Promise((resolvePromise) => setTimeout(resolvePromise, ms)); }
function nowMs() { return performance.now(); }

async function withTimeout(promise, timeoutMs, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try { return await Promise.race([promise, timeout]); }
    finally { clearTimeout(timer); }
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

function spawnVelora(port, options, stdoutChunks, stderrChunks) {
    const proc = spawn(veloraBin, [
        "serve", "--host", options.host, "--port", String(port),
        "--log-level", options.logLevel, "--log-format", options.logFormat,
        "--http-timeout", String(options.httpTimeoutMs),
    ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    return proc;
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
        } catch (_) {}
        await delay(100);
    }
    throw new Error(`Timed out waiting for ${url}`);
}

function toRelativePath(path) {
    const absolute = resolve(testRoot, path);
    const rel = relative(testRoot, absolute).split(sep).join("/");
    if (rel.startsWith("..") || rel === "") throw new Error(`Path is outside velora-test: ${path}`);
    return rel;
}

function collectHtmlFiles(inputPaths) {
    const roots = inputPaths.length > 0 ? inputPaths : ["."];
    const files = [];
    const visit = (relPath) => {
        const absolute = resolve(testRoot, relPath);
        if (!absolute.startsWith(testRoot + sep) && absolute !== testRoot) throw new Error(`Path is outside velora-test: ${relPath}`);
        if (!existsSync(absolute)) throw new Error(`Test path not found: ${relPath}`);
        const stat = statSync(absolute);
        if (stat.isDirectory()) {
            for (const entry of readdirSync(absolute).sort()) {
                if (entry.startsWith(".")) continue;
                visit(relative(testRoot, resolve(absolute, entry)).split(sep).join("/"));
            }
            return;
        }
        if (stat.isFile() && extname(absolute).toLowerCase() === ".html") files.push(toRelativePath(relPath));
    };
    for (const inputPath of roots) visit(inputPath);
    return Array.from(new Set(files)).sort();
}

function resolveStaticPath(urlPath) {
    const decodedPath = decodeURIComponent(urlPath.split("?")[0]);
    const safePath = normalize(decodedPath).replace(/^(\.\.(?:[/\\]|$))+/, "");
    const absolute = resolve(testRoot, `.${safePath}`);
    if (!absolute.startsWith(testRoot + sep) && absolute !== testRoot) return null;
    return absolute;
}

function startStaticServer(host, port) {
    const server = createHttpServer((req, res) => {
        let filePath = resolveStaticPath(req.url || "/");
        if (filePath && existsSync(filePath) && statSync(filePath).isDirectory()) filePath = resolve(filePath, "index.html");
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
            clearTimeout(callback.timer);
            callback.reject(err);
            callbacks.delete(id);
        }
    }

    ws.addEventListener("message", (event) => {
        const message = JSON.parse(event.data);
        if (message.id == null || !callbacks.has(message.id)) return;
        const callback = callbacks.get(message.id);
        callbacks.delete(message.id);
        clearTimeout(callback.timer);
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
                const timer = setTimeout(() => {
                    callbacks.delete(id);
                    reject(new Error(`${method} timed out after ${timeoutMs}ms`));
                }, timeoutMs);
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

async function createVeloraPage(cdp) {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    return { targetId, sessionId };
}

async function runVeloraOnce(cdp, page, url, options) {
    const started = nowMs();
    try {
        await cdp.send("Page.navigate", { url }, page.sessionId, options.timeoutMs);
        if (options.settleMs) await delay(options.settleMs);
        await cdp.send("Runtime.evaluate", { expression: "document.documentElement && document.documentElement.outerHTML.length", returnByValue: true }, page.sessionId, options.timeoutMs);
        return { ok: true, ms: nowMs() - started };
    } catch (err) {
        return { ok: false, ms: nowMs() - started, error: err.message };
    }
}

async function runChromeOnce(browser, url, options) {
    const started = nowMs();
    const page = await browser.newPage();
    try {
        await withTimeout(page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs }), options.timeoutMs + 500, "chromium navigation");
        if (options.settleMs) await page.waitForTimeout(options.settleMs);
        await page.evaluate(() => document.documentElement && document.documentElement.outerHTML.length);
        return { ok: true, ms: nowMs() - started };
    } catch (err) {
        return { ok: false, ms: nowMs() - started, error: err.message };
    } finally {
        await page.close().catch(() => undefined);
    }
}

function stats(samples) {
    const ok = samples.filter((sample) => sample.ok && Number.isFinite(sample.ms)).map((sample) => sample.ms).sort((a, b) => a - b);
    const sum = ok.reduce((acc, n) => acc + n, 0);
    return {
        ok: ok.length,
        errors: samples.length - ok.length,
        minMs: ok.length ? ok[0] : null,
        meanMs: ok.length ? sum / ok.length : null,
        medianMs: ok.length ? ok[Math.floor(ok.length / 2)] : null,
        maxMs: ok.length ? ok[ok.length - 1] : null,
    };
}

function fmt(n) { return n == null ? "n/a" : n.toFixed(1); }
function ratio(velora, chrome) { return velora && chrome ? velora / chrome : null; }

async function runBrowserBench(name, files, runOnce, baseUrl, options) {
    const results = [];
    for (const file of files) {
        const url = `${baseUrl}/${file.split("/").map(encodeURIComponent).join("/")}`;
        const samples = [];
        for (let i = 0; i < options.warmup; i += 1) await runOnce(url, options);
        for (let i = 0; i < options.repeats; i += 1) samples.push(await runOnce(url, options));
        const summary = stats(samples);
        results.push({ file, url, summary, samples });
        process.stdout.write(`${name.padEnd(8)} ${file.padEnd(45)} mean=${fmt(summary.meanMs)}ms median=${fmt(summary.medianMs)}ms errors=${summary.errors}\n`);
    }
    return results;
}

function writeJsonFile(path, value) {
    const dir = resolve(path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { console.log(usage()); return; }
    if (!existsSync(veloraBin)) throw new Error(`Velora binary not found: ${veloraBin}. Run: zig build`);
    for (const dir of [tmpDir, outputDir, logDir, resolve(options.report, ".."), resolve(options.log, "..")]) {
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    const files = collectHtmlFiles(options.paths).filter((file) => file !== "endless.html");
    if (files.length === 0) throw new Error("No .html files found in velora-test selection");

    const staticPort = await getFreePort(options.host);
    const veloraPort = await getFreePort(options.host);
    const staticServer = await startStaticServer(options.host, staticPort);
    const baseUrl = `http://${options.host}:${staticPort}`;
    const cdpEndpoint = `http://${options.host}:${veloraPort}`;

    const stdoutChunks = [];
    const stderrChunks = [];
    let proc = spawnVelora(veloraPort, options, stdoutChunks, stderrChunks);

    let cdp;
    let browser;
    let veloraPage;
    const restartVelora = async () => {
        if (cdp) cdp.close();
        await stopProcess(proc);
        proc = spawnVelora(veloraPort, options, stdoutChunks, stderrChunks);
        await waitForServer(`${cdpEndpoint}/json/version`, options.serverTimeoutMs);
        cdp = await connectCDP(cdpEndpoint, options);
        veloraPage = await createVeloraPage(cdp);
    };
    try {
        const { chromium } = require("playwright");
        await restartVelora();
        browser = await chromium.launch({ headless: true });

        console.log(`Benchmarking ${files.length} file(s), repeats=${options.repeats}, warmup=${options.warmup}, timeout=${options.timeoutMs}ms`);
        console.log("\nVelora");
        const velora = await runBrowserBench("velora", files, async (url, opts) => {
            const result = await runVeloraOnce(cdp, veloraPage, url, opts);
            if (!result.ok && /websocket|not open/i.test(result.error || "")) await restartVelora().catch(() => undefined);
            return result;
        }, baseUrl, options);
        console.log("\nChromium");
        const chrome = await runBrowserBench("chrome", files, (url, opts) => runChromeOnce(browser, url, opts), baseUrl, options);

        const rows = files.map((file, index) => {
            const v = velora[index].summary;
            const c = chrome[index].summary;
            return { file, veloraMeanMs: v.meanMs, chromeMeanMs: c.meanMs, ratio: ratio(v.meanMs, c.meanMs), veloraErrors: v.errors, chromeErrors: c.errors };
        });
        console.log("\nComparison (mean ms)");
        for (const row of rows) {
            console.log(`${row.file.padEnd(45)} velora=${fmt(row.veloraMeanMs)} chrome=${fmt(row.chromeMeanMs)} ratio=${row.ratio == null ? "n/a" : `${row.ratio.toFixed(2)}x`}`);
        }

        const validRows = rows.filter((row) => row.ratio != null);
        const geomeanRatio = validRows.length
            ? Math.exp(validRows.reduce((acc, row) => acc + Math.log(row.ratio), 0) / validRows.length)
            : null;
        const report = { baseUrl, root: testRoot, options: { repeats: options.repeats, warmup: options.warmup, timeoutMs: options.timeoutMs }, summary: { files: files.length, geomeanRatio }, rows, velora, chrome };
        writeJsonFile(options.report, report);
        console.log(`\nGeomean Velora/Chrome ratio: ${geomeanRatio == null ? "n/a" : `${geomeanRatio.toFixed(2)}x`}`);
        console.log(`saved report: ${options.report}`);
    } finally {
        if (browser) await browser.close().catch(() => undefined);
        if (cdp && veloraPage) await cdp.send("Target.closeTarget", { targetId: veloraPage.targetId }, undefined, options.commandTimeoutMs).catch(() => undefined);
        if (cdp) cdp.close();
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
