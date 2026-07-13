import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { execSync } from "node:child_process";
import { arch, cpus, hostname, platform, release } from "node:os";
import { extname, normalize, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { WebSocket } from "ws";

const require = createRequire(import.meta.url);
const benchDir = resolve(fileURLToPath(import.meta.url), "..");
export const repoRoot = resolve(benchDir, "../../..");
export const testRoot = resolve(repoRoot, "velora-test");
export const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
export const veloraBuildMetaPath = resolve(repoRoot, "zig-out/bin/velora.build.json");

export function readVeloraBuildMeta() {
    if (!existsSync(veloraBuildMetaPath)) return null;
    try {
        return JSON.parse(readFileSync(veloraBuildMetaPath, "utf8"));
    } catch (_) {
        return null;
    }
}

export function assertReleaseFastBinary() {
    if (!existsSync(veloraBin)) {
        throw new Error(`Velora binary not found: ${veloraBin}. Run: npm run bench:preflight`);
    }
    const meta = readVeloraBuildMeta();
    if (!meta?.optimize) {
        throw new Error(
            `Missing ${veloraBuildMetaPath}. Run: npm run bench:preflight (zig build -Doptimize=ReleaseFast)`,
        );
    }
    if (meta.optimize !== "ReleaseFast") {
        throw new Error(
            `Velora optimize mode is "${meta.optimize}", expected ReleaseFast. Run: npm run bench:preflight`,
        );
    }
    return meta;
}

export function veloraBuildMetaForReport() {
    const meta = readVeloraBuildMeta();
    return {
        veloraOptimizeMode: meta?.optimize ?? "unknown",
        veloraBuildBuiltAt: meta?.builtAt ?? null,
    };
}

export const BENCHMARK_ASSUMPTIONS = {
    compare: {
        veloraPageReuse: true,
        chromiumFreshPagePerIteration: true,
        navigationWaitUntil: "domcontentloaded",
        requiresReleaseFast: true,
    },
    crawlDensity: {
        veloraMultiProcess: true,
        veloraMeasurementStack: "cdp-fetchPage",
        chromiumMeasurementStack: "cdp-fetchPage",
    },
    crawlFair: {
        veloraMultiProcess: false,
        veloraHttpCache: true,
        warmup: true,
        veloraMeasurementStack: "cdp-fetchPage",
        chromiumMeasurementStack: "cdp-fetchPage",
    },
    googleAgent: {
        veloraWarmedCookies: true,
        chromiumColdSession: true,
        note: "Antibot session state mixed with extract latency — not a pure perf compare.",
    },
};

export const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
};

export const JS_WORKLOADS = [
    { name: "dom-query", page: "dom-heavy.html", call: `(() => { const t0 = performance.now(); document.querySelectorAll("[data-bench]"); return performance.now() - t0; })()` },
    { name: "json-loop", page: "js-compute.html", call: `window.__benchRun("json-loop").ms` },
    { name: "hash-loop", page: "js-compute.html", call: `window.__benchRun("hash-loop").ms` },
];

export function delay(ms) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function nowMs() {
    return performance.now();
}

export async function withTimeout(promise, timeoutMs, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    try {
        return await Promise.race([promise, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

export async function stopProcess(proc, signal = "SIGTERM", timeoutMs = 2000) {
    if (proc.exitCode != null || proc.signalCode != null) return;
    const exited = new Promise((resolvePromise) => proc.once("exit", resolvePromise));
    proc.kill(signal);
    const timedOut = await Promise.race([exited.then(() => false), delay(timeoutMs).then(() => true)]);
    if (timedOut && proc.exitCode == null && proc.signalCode == null) {
        proc.kill("SIGKILL");
        await exited;
    }
}

export function spawnVelora(port, options, stdoutChunks = [], stderrChunks = []) {
    const args = [
        "serve",
        "--host", options.host,
        "--port", String(port),
        "--log-level", options.logLevel,
        "--log-format", options.logFormat,
        "--http-timeout", String(options.httpTimeoutMs),
    ];
    if (options.browserProfile) {
        args.push("--browser-profile", options.browserProfile);
    }
    const proc = spawn(veloraBin, args, {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
    proc.stderr.on("data", (chunk) => stderrChunks.push(chunk));
    return proc;
}

export async function getFreePort(host = "127.0.0.1") {
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

export async function waitForServer(url, timeoutMs) {
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

export function collectHtmlFiles(inputPaths = []) {
    const roots = inputPaths.length > 0 ? inputPaths : ["."];
    const files = [];
    const visit = (relPath) => {
        const absolute = resolve(testRoot, relPath);
        if (!absolute.startsWith(testRoot + sep) && absolute !== testRoot) {
            throw new Error(`Path is outside velora-test: ${relPath}`);
        }
        if (!existsSync(absolute)) throw new Error(`Test path not found: ${relPath}`);
        const stat = statSync(absolute);
        if (stat.isDirectory()) {
            for (const entry of readdirSync(absolute).sort()) {
                if (entry.startsWith(".")) continue;
                visit(relative(testRoot, resolve(absolute, entry)).split(sep).join("/"));
            }
            return;
        }
        if (stat.isFile() && extname(absolute).toLowerCase() === ".html") {
            files.push(toRelativePath(relPath));
        }
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

export function startStaticServer(host, port) {
    const server = createHttpServer((req, res) => {
        let filePath = resolveStaticPath(req.url || "/");
        if (filePath && existsSync(filePath) && statSync(filePath).isDirectory()) {
            filePath = resolve(filePath, "index.html");
        }
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

export async function connectCDP(cdpEndpoint, options) {
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

    const eventListeners = new Map();

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
        if (message.method) {
            const key = `${message.method}|${message.sessionId || ""}`;
            const subs = eventListeners.get(key);
            if (subs) {
                for (const cb of subs) cb(message.params || {});
            }
        }
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
        onEvent(method, sessionId, cb) {
            const key = `${method}|${sessionId || ""}`;
            let list = eventListeners.get(key);
            if (!list) {
                list = [];
                eventListeners.set(key, list);
            }
            list.push(cb);
            return () => {
                const index = list.indexOf(cb);
                if (index >= 0) list.splice(index, 1);
            };
        },
        waitForEvent(method, sessionId, timeoutMs, label = method) {
            return withTimeout(
                new Promise((resolvePromise) => {
                    const off = this.onEvent(method, sessionId, () => {
                        off();
                        resolvePromise();
                    });
                }),
                timeoutMs,
                label,
            );
        },
        send(method, params = {}, sessionId, timeoutMs = options.commandTimeoutMs) {
            if (closed || ws.readyState !== WebSocket.OPEN) {
                return Promise.reject(new Error(`Cannot send ${method}: CDP websocket is not open`));
            }
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

export async function createVeloraPage(cdp) {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    return { targetId, sessionId };
}

export async function runVeloraNavigate(cdp, page, url, options) {
    const started = nowMs();
    try {
        await cdp.send("Page.navigate", { url }, page.sessionId, options.timeoutMs);
        await cdp.waitForEvent("Page.domContentEventFired", page.sessionId, options.timeoutMs, "velora domcontentloaded");
        if (options.settleMs) await delay(options.settleMs);
        await cdp.send(
            "Runtime.evaluate",
            { expression: "document.documentElement && document.documentElement.outerHTML.length", returnByValue: true },
            page.sessionId,
            options.timeoutMs,
        );
        return { ok: true, ms: nowMs() - started };
    } catch (err) {
        return { ok: false, ms: nowMs() - started, error: err.message };
    }
}

export async function runChromeNavigate(browser, url, options) {
    const started = nowMs();
    const page = await browser.newPage();
    try {
        await withTimeout(
            page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs }),
            options.timeoutMs + 500,
            "chromium navigation",
        );
        if (options.settleMs) await page.waitForTimeout(options.settleMs);
        await page.evaluate(() => document.documentElement && document.documentElement.outerHTML.length);
        return { ok: true, ms: nowMs() - started, page };
    } catch (err) {
        await page.close().catch(() => undefined);
        return { ok: false, ms: nowMs() - started, error: err.message };
    }
}

export async function runVeloraJs(cdp, page, url, expression, options) {
    const started = nowMs();
    try {
        await cdp.send("Page.navigate", { url }, page.sessionId, options.timeoutMs);
        await cdp.waitForEvent("Page.domContentEventFired", page.sessionId, options.timeoutMs, "velora domcontentloaded");
        const result = await cdp.send(
            "Runtime.evaluate",
            { expression, returnByValue: true, awaitPromise: true },
            page.sessionId,
            options.timeoutMs,
        );
        const value = result?.result?.value;
        if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new Error(`JS workload returned invalid value: ${JSON.stringify(value)}`);
        }
        return { ok: true, ms: value, totalMs: nowMs() - started };
    } catch (err) {
        return { ok: false, ms: nowMs() - started, error: err.message };
    }
}

export async function runChromeJs(browser, url, expression, options) {
    const started = nowMs();
    const page = await browser.newPage();
    try {
        await withTimeout(
            page.goto(url, { waitUntil: "domcontentloaded", timeout: options.timeoutMs }),
            options.timeoutMs + 500,
            "chromium navigation",
        );
        const value = await page.evaluate((expr) => {
            // eslint-disable-next-line no-eval
            return eval(expr);
        }, expression);
        if (typeof value !== "number" || !Number.isFinite(value)) {
            throw new Error(`JS workload returned invalid value: ${JSON.stringify(value)}`);
        }
        return { ok: true, ms: value, totalMs: nowMs() - started };
    } catch (err) {
        return { ok: false, ms: nowMs() - started, error: err.message };
    } finally {
        await page.close().catch(() => undefined);
    }
}

export function stats(samples) {
    const ok = samples
        .filter((sample) => sample.ok && Number.isFinite(sample.ms))
        .map((sample) => sample.ms)
        .sort((a, b) => a - b);
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

export function fmt(n) {
    return n == null ? "n/a" : n.toFixed(1);
}

export function ratio(velora, chrome) {
    return velora && chrome ? velora / chrome : null;
}

export function geomean(values) {
    const valid = values.filter((v) => v != null && Number.isFinite(v) && v > 0);
    if (valid.length === 0) return null;
    return Math.exp(valid.reduce((acc, v) => acc + Math.log(v), 0) / valid.length);
}

export function writeJsonFile(path, value) {
    const dir = resolve(path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function collectMeta(options) {
    let gitSha = null;
    try {
        gitSha = execSync("git rev-parse --short HEAD", { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] })
            .toString()
            .trim();
    } catch (_) {}

    let playwrightVersion = null;
    try {
        const pkg = require(resolve(repoRoot, "node_modules/playwright/package.json"));
        playwrightVersion = pkg.version;
    } catch (_) {}

    const cpu = cpus()[0];
    return {
        date: new Date().toISOString().slice(0, 10),
        timestamp: new Date().toISOString(),
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        osRelease: release(),
        cpu: cpu ? `${cpu.model} (${cpus().length} cores)` : null,
        node: process.version,
        playwright: playwrightVersion,
        gitSha,
        veloraProfile: options.browserProfile,
        chromiumTarget: "playwright-chromium-headless",
        repeats: options.repeats,
        warmup: options.warmup,
        startupRepeats: options.startupRepeats,
        startupWarmup: options.startupWarmup,
        timeoutMs: options.timeoutMs,
        navMode: options.navMode ?? "reuse",
        benchmarkAssumptions: {
            ...BENCHMARK_ASSUMPTIONS.compare,
            navMode: options.navMode ?? "reuse",
        },
        ...veloraBuildMetaForReport(),
    };
}

export async function measureVeloraStartup(options) {
    const port = await getFreePort(options.host);
    const endpoint = `http://${options.host}:${port}`;
    const runOnce = async () => {
        const started = nowMs();
        const proc = spawnVelora(port, options);
        try {
            await waitForServer(`${endpoint}/json/version`, options.serverTimeoutMs);
            return { ok: true, ms: nowMs() - started };
        } catch (err) {
            return { ok: false, ms: nowMs() - started, error: err.message };
        } finally {
            await stopProcess(proc);
        }
    };
    const samples = [];
    for (let i = 0; i < options.startupWarmup; i += 1) await runOnce();
    for (let i = 0; i < options.startupRepeats; i += 1) samples.push(await runOnce());
    return { samples, summary: stats(samples) };
}

export async function measureChromiumStartup(chromium, options) {
    const runOnce = async () => {
        const started = nowMs();
        let browser;
        try {
            browser = await chromium.launch({ headless: true });
            const page = await browser.newPage();
            await page.goto("about:blank");
            return { ok: true, ms: nowMs() - started };
        } catch (err) {
            return { ok: false, ms: nowMs() - started, error: err.message };
        } finally {
            if (browser) await browser.close().catch(() => undefined);
        }
    };
    const samples = [];
    for (let i = 0; i < options.startupWarmup; i += 1) await runOnce();
    for (let i = 0; i < options.startupRepeats; i += 1) samples.push(await runOnce());
    return { samples, summary: stats(samples) };
}

export async function runBrowserBench(name, items, runOnce, options, labelKey = "file") {
    const results = [];
    for (const item of items) {
        const label = item[labelKey];
        const samples = [];
        for (let i = 0; i < options.warmup; i += 1) await runOnce(item, options);
        for (let i = 0; i < options.repeats; i += 1) samples.push(await runOnce(item, options));
        const summary = stats(samples);
        results.push({ ...item, summary, samples });
        process.stdout.write(
            `${name.padEnd(9)} ${String(label).padEnd(40)} mean=${fmt(summary.meanMs)}ms median=${fmt(summary.medianMs)}ms errors=${summary.errors}\n`,
        );
    }
    return results;
}

export function ensureDir(path) {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

export function readJsonFile(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}