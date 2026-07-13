import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { arch, cpus, hostname, platform, release } from "node:os";
import { execSync } from "node:child_process";
import { WebSocket } from "ws";

import { assertReleaseFastBinary, BENCHMARK_ASSUMPTIONS, veloraBuildMetaForReport } from "./compare-core.mjs";
import { ProcessMonitor } from "./process-monitor.mjs";

const require = createRequire(import.meta.url);

export const repoRoot = resolve(import.meta.dirname, "../../..");
export const veloraBin = resolve(repoRoot, "zig-out/bin/velora");

export const TTFX_EXPR = `(() => {
    const el = document.querySelector("#firstHeading") || document.querySelector("h1");
    return el?.textContent?.trim() || null;
})()`;

export const EXTRACT_EXPR = `(() => {
    const links = document.querySelectorAll('a[href^="/wiki/"]:not([href*=":"])');
    const title = document.querySelector("#firstHeading")?.textContent?.trim()
        || document.title.replace(/ - Wikipedia$/, "").trim();
    return {
        title,
        linkCount: links.length,
        htmlBytes: document.documentElement?.outerHTML?.length ?? 0,
    };
})()`;

export function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

export function slugify(title) {
    return title
        .replace(/[\\/:*?"<>|]+/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 180) || "untitled";
}

export async function getFreePort(host = "127.0.0.1") {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.unref();
        s.on("error", rej);
        s.listen(0, host, () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
    });
}

export async function waitFor(url, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(url);
            if (r.ok) return;
        } catch (_) {}
        await delay(50);
    }
    throw new Error(`waitFor timed out: ${url}`);
}

export async function fetchRandomTitles(lang, limit) {
    const titles = [];
    const seen = new Set();
    const apiBase = `https://${lang}.wikipedia.org/w/api.php`;
    while (titles.length < limit) {
        const chunk = Math.min(500, limit - titles.length);
        const url = `${apiBase}?action=query&list=random&rnnamespace=0&rnlimit=${chunk}&format=json&origin=*`;
        const res = await fetch(url, {
            headers: { "user-agent": "velora-crawl-benchmark/1.0 (research; contact: local)" },
        });
        if (!res.ok) throw new Error(`wiki api ${res.status}`);
        const data = await res.json();
        for (const item of data?.query?.random ?? []) {
            if (!seen.has(item.title)) {
                seen.add(item.title);
                titles.push(item.title);
                if (titles.length >= limit) break;
            }
        }
        if (titles.length === 0) throw new Error("wiki api returned no titles");
    }
    return titles;
}

export function buildQueue(lang, titles) {
    return titles.map((title, i) => ({
        i,
        title,
        url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
    }));
}

/** Fixed wiki page for pre-measurement warmup (not in the crawl queue). */
export function warmupUrlFor(lang = "en") {
    return `https://${lang}.wikipedia.org/wiki/Main_Page`;
}

/** Profile-scoped on-disk HTTP cache for fair crawl lane. */
export function profileHttpCacheDir(opts) {
    if (opts.enableHttpCache !== true) return null;
    if (typeof opts.httpCacheDir === "string") return opts.httpCacheDir;
    const profile = opts.browserProfile || "default";
    const safe = profile.replace(/[^a-zA-Z0-9._-]+/g, "_");
    return resolve(repoRoot, "code-check/tmp/benchmarks/cache", safe);
}

export function buildVeloraServeArgs(port, opts) {
    const args = [
        "serve",
        "--host", "127.0.0.1",
        "--port", String(port),
        "--log-level", opts.logLevel ?? "warn",
        "--browser-profile", opts.browserProfile,
        "--http-timeout", String(opts.timeoutMs),
    ];
    if (opts.automation) args.push("--automation", opts.automation);
    const httpCacheDir = profileHttpCacheDir(opts);
    if (httpCacheDir) {
        mkdirSync(httpCacheDir, { recursive: true });
        args.push("--http-cache-dir", httpCacheDir);
    }
    return { args, httpCacheDir };
}

const defaultDensityReport = resolve(repoRoot, "code-check/tmp/benchmarks/crawl-wikipedia.json");
const defaultFairReport = resolve(repoRoot, "code-check/tmp/benchmarks/crawl-wikipedia-fair.json");

/** Apply lane presets without breaking the legacy density default. */
export function applyLaneDefaults(opts) {
    const lane = opts.lane ?? "density";
    opts.lane = lane;
    if (lane === "fair") {
        opts.veloraMultiProcess = false;
        if (!opts.warmupExplicit) opts.warmup = true;
        opts.enableHttpCache = true;
        opts.benchmarkLane = "fair";
        opts.benchmarkName = "Wikipedia crawl — fair throughput lane";
        if (!opts.reportExplicit) {
            opts.report = defaultFairReport;
        }
        return opts;
    }
    opts.veloraMultiProcess = opts.veloraMultiProcess !== false;
    if (!opts.warmupExplicit) opts.warmup = false;
    opts.enableHttpCache = false;
    opts.benchmarkLane = "density";
    opts.benchmarkName = "Wikipedia crawl — agent density lane";
    if (!opts.reportExplicit) {
        opts.report = defaultDensityReport;
    }
    return opts;
}

export async function preWarmupVeloraServe(endpoint, opts) {
    const client = await connectCdp(endpoint, 15_000);
    try {
        const { browserContextId } = await client.send("Target.createBrowserContext", {});
        const { targetId } = await client.send("Target.createTarget", {
            url: "about:blank",
            browserContextId,
        });
        const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
        await client.send("Page.enable", {}, sessionId);
        await client.send("Runtime.enable", {}, sessionId);
        const url = opts.warmupUrl ?? warmupUrlFor(opts.lang);
        await fetchPage(client, sessionId, url, opts.timeoutMs, opts.mode, opts.expressions, opts.pageWaitFor);
        await client.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
    } finally {
        client.close();
    }
}

export async function preWarmupChromium(client, opts) {
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);
    try {
        const url = opts.warmupUrl ?? warmupUrlFor(opts.lang);
        await fetchPage(client, sessionId, url, opts.timeoutMs, opts.mode, opts.expressions, opts.pageWaitFor);
    } finally {
        await client.send("Target.closeTarget", { targetId }).catch(() => {});
    }
}

export class CdpClient {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        this.eventListeners = new Map();
        this.closed = false;
        this._sendChain = Promise.resolve();
        ws.addEventListener("close", () => {
            this.closed = true;
            for (const p of this.pending.values()) p.reject(new Error("ws closed"));
            this.pending.clear();
        });
        ws.addEventListener("message", (ev) => this._onMessage(ev));
    }

    _onMessage(ev) {
        let m;
        try {
            m = JSON.parse(ev.data);
        } catch {
            return;
        }
        if (m.id != null && this.pending.has(m.id)) {
            const p = this.pending.get(m.id);
            this.pending.delete(m.id);
            if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
            else p.resolve(m.result || {});
            return;
        }
        if (m.method) {
            const key = `${m.method}|${m.sessionId || ""}`;
            const subs = this.eventListeners.get(key);
            if (subs) for (const cb of subs) cb(m.params || {});
        }
    }

    onEvent(method, sessionId, cb) {
        const key = `${method}|${sessionId || ""}`;
        let list = this.eventListeners.get(key);
        if (!list) {
            list = [];
            this.eventListeners.set(key, list);
        }
        list.push(cb);
        return () => {
            const i = list.indexOf(cb);
            if (i >= 0) list.splice(i, 1);
        };
    }

    send(method, params = {}, sessionId, timeoutMs = 30000) {
        const run = () => this._send(method, params, sessionId, timeoutMs);
        const p = this._sendChain.then(run, run);
        this._sendChain = p.catch(() => {});
        return p;
    }

    _send(method, params = {}, sessionId, timeoutMs = 30000) {
        if (this.closed) return Promise.reject(new Error(`ws closed before ${method}`));
        const id = this.nextId++;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        return new Promise((res, rej) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                rej(new Error(`${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, {
                method,
                resolve: (v) => {
                    clearTimeout(timer);
                    res(v);
                },
                reject: (e) => {
                    clearTimeout(timer);
                    rej(e);
                },
            });
            this.ws.send(JSON.stringify(payload));
        });
    }

    close() {
        try {
            this.ws.close();
        } catch (_) {}
    }
}

export async function connectCdp(endpoint, timeoutMs = 10000) {
    await waitFor(`${endpoint}/json/version`, timeoutMs);
    const v = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", rej, { once: true });
    });
    return new CdpClient(ws);
}

export async function fetchPage(client, sessionId, url, timeoutMs, mode, expr = {}, pageWaitFor = "domcontentloaded") {
    const ttfxExpr = expr.ttfx ?? TTFX_EXPR;
    const extractExpr = expr.extract ?? EXTRACT_EXPR;
    const t0 = Date.now();
    const readyOnce = new Promise((res) => {
        const event = pageWaitFor === "load" ? "Page.loadEventFired" : "Page.domContentEventFired";
        const off = client.onEvent(event, sessionId, () => {
            off();
            res();
        });
    });
    const nav = await client.send("Page.navigate", { url }, sessionId, timeoutMs);
    if (nav.errorText) throw new Error(`navigate: ${nav.errorText}`);
    const readyEvent = pageWaitFor === "load" ? "Page.loadEventFired" : "Page.domContentEventFired";
    const readyTimeoutMs = Math.min(timeoutMs, 12000);
    await Promise.race([
        readyOnce,
        delay(readyTimeoutMs).then(() => Promise.reject(new Error(`${readyEvent} not fired within ${readyTimeoutMs}ms`))),
    ]);
    const domReadyMs = Date.now() - t0;

    let ttfexMs = domReadyMs;
    if (mode !== "html") {
        let ttfTitle = null;
        const pollUntil = Date.now() + Math.min(timeoutMs, 8000);
        while (Date.now() < pollUntil) {
            const ttfRes = await client.send(
                "Runtime.evaluate",
                { expression: ttfxExpr, returnByValue: true, awaitPromise: false, timeout: timeoutMs },
                sessionId,
                timeoutMs,
            );
            if (ttfRes.exceptionDetails) {
                throw new Error(ttfRes.exceptionDetails.text || "ttfx failed");
            }
            ttfTitle = ttfRes?.result?.value;
            if (ttfTitle) break;
            await delay(150);
        }
        if (!ttfTitle) throw new Error("ttfx: extractable element not found");
        ttfexMs = Date.now() - t0;
    }

    const expression = mode === "html"
        ? "document.documentElement && document.documentElement.outerHTML"
        : extractExpr;

    const evalRes = await client.send(
        "Runtime.evaluate",
        { expression, returnByValue: true, awaitPromise: false, timeout: timeoutMs },
        sessionId,
        timeoutMs,
    );
    if (evalRes.exceptionDetails) {
        throw new Error(evalRes.exceptionDetails.text || "evaluate failed");
    }

    const totalMs = Date.now() - t0;
    const extractMs = totalMs - ttfexMs;

    const value = evalRes?.result?.value;
    if (mode === "html") {
        if (typeof value !== "string" || value.length < 500) {
            throw new Error(`empty html (len=${value?.length ?? -1})`);
        }
        return { htmlBytes: value.length, domReadyMs, ttfexMs: domReadyMs, extractMs: 0, totalMs };
    }

    if (!value || typeof value !== "object") {
        throw new Error("invalid extract payload");
    }
    if (expr.validate) {
        expr.validate(value);
    } else if (!value.title || value.linkCount < 1) {
        throw new Error(`weak page data: title=${value.title} links=${value.linkCount}`);
    }
    return {
        ...value,
        domReadyMs,
        ttfexMs,
        extractMs,
        totalMs,
    };
}

export function summarize(results, wallMs, parallelism, extra = {}, benchmarkClass = "crawler-runtime") {
    const ok = results.filter((r) => r.ok);
    const fail = results.filter((r) => !r.ok);
    const latencies = ok.map((r) => r.ms).sort((a, b) => a - b);
    const meanMs = latencies.length ? latencies.reduce((s, n) => s + n, 0) / latencies.length : null;
    const medianMs = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;
    const totalHtmlBytes = ok.reduce((s, r) => s + (r.htmlBytes ?? 0), 0);
    const totalLinks = ok.reduce((s, r) => s + (r.linkCount ?? 0), 0);
    const ttfex = ok.map((r) => r.ttfexMs).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    const domReady = ok.map((r) => r.domReadyMs).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);

    return {
        ...extra,
        benchmarkClass,
        workloadNote: benchmarkClass === "agent-extract"
            ? "Agent extract: navigate live page → TTFX on first DOM hit → structured extract."
            : "Network + HTML parse + DOM extract. Not a full browser fidelity benchmark (no WebGL/SPA/hydration).",
        parallelism,
        pages: results.length,
        success: ok.length,
        failed: fail.length,
        wallMs,
        throughputPagesPerSec: wallMs > 0 ? results.length / (wallMs / 1000) : null,
        meanMs,
        medianMs,
        meanTtfexMs: ttfex.length ? ttfex.reduce((s, n) => s + n, 0) / ttfex.length : null,
        medianTtfexMs: ttfex.length ? ttfex[Math.floor(ttfex.length / 2)] : null,
        meanDomReadyMs: domReady.length ? domReady.reduce((s, n) => s + n, 0) / domReady.length : null,
        totalHtmlBytes,
        totalLinks,
        failures: fail.slice(0, 10).map((f) => ({ title: f.title, error: f.error })),
        results,
    };
}

async function runPool(items, parallelism, workerFn, interItemDelayMs = 0) {
    let next = 0;
    const results = [];
    const runners = Array.from({ length: parallelism }, async (_, workerId) => {
        const ctx = await workerFn(workerId);
        try {
            while (true) {
                const idx = next++;
                if (idx >= items.length) break;
                const item = items[idx];
                const t0 = Date.now();
                try {
                    const data = await ctx.fetch(item);
                    results.push({
                        ok: true,
                        idx: item.i,
                        title: data.title || item.title,
                        url: item.url,
                        ms: data.totalMs ?? (Date.now() - t0),
                        worker: workerId,
                        ...data,
                    });
                } catch (err) {
                    results.push({
                        ok: false,
                        idx: item.i,
                        title: item.title,
                        url: item.url,
                        ms: Date.now() - t0,
                        worker: workerId,
                        error: err.message,
                    });
                }
                if (interItemDelayMs > 0) await delay(interItemDelayMs);
            }
        } finally {
            await ctx.close?.();
        }
    });
    await Promise.all(runners);
    results.sort((a, b) => a.idx - b.idx);
    return results;
}

export async function crawlVelora(queue, opts) {
    assertReleaseFastBinary();

    const parallelism = Math.max(1, Math.min(opts.concurrency, queue.length));
    const multiProcess = opts.veloraMultiProcess === true;
    const monitor = new ProcessMonitor({ label: "velora", intervalMs: opts.sampleIntervalMs ?? 100 });
    const wallStart = Date.now();

    if (multiProcess) {
        let monitorStarted = false;
        const results = await runPool(queue, parallelism, async (workerId) => {
            const port = await getFreePort();
            const { args } = buildVeloraServeArgs(port, opts);
            const proc = spawn(veloraBin, args, { cwd: repoRoot, stdio: "ignore" });
            monitor.addRootPid(proc.pid);
            if (!monitorStarted) {
                monitor.start();
                monitorStarted = true;
            }
            const endpoint = `http://127.0.0.1:${port}`;
            await waitFor(`${endpoint}/json/version`, 15_000);
            const client = await connectCdp(endpoint, 8000);
            const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
            const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
            await client.send("Page.enable", {}, sessionId);
            await client.send("Runtime.enable", {}, sessionId);

            return {
                pid: proc.pid,
                fetch: (item) => fetchPage(
                    client,
                    sessionId,
                    item.url,
                    opts.timeoutMs,
                    opts.mode,
                    opts.expressions,
                    opts.pageWaitFor,
                ),
                close: async () => {
                    client.close();
                    if (proc.exitCode == null) {
                        proc.kill("SIGTERM");
                        await new Promise((r) => proc.once("exit", r));
                    }
                },
            };
        }, opts.interItemDelayMs ?? 0);
        const resources = monitor.stop(queue.length, parallelism);
        return summarize(results, Date.now() - wallStart, parallelism, {
            engine: "velora",
            resources,
            parallelismModel: "multi-process",
            architectureNote: "Velora: N isolated velora serve processes (1 CDP tab each, fetchPage timing). RSS sums worker trees.",
            veloraMeasurementStack: "cdp-fetchPage",
        }, opts.benchmarkClass);
    }

    const port = await getFreePort();
    const { args, httpCacheDir } = buildVeloraServeArgs(port, opts);
    const proc = spawn(veloraBin, args, { cwd: repoRoot, stdio: "ignore" });
    monitor.addRootPid(proc.pid);

    try {
        const endpoint = `http://127.0.0.1:${port}`;
        await waitFor(`${endpoint}/json/version`, 15_000);
        if (opts.warmup) {
            console.log(`[warmup] Velora single-process → ${opts.warmupUrl ?? warmupUrlFor(opts.lang)}`);
            await preWarmupVeloraServe(endpoint, opts);
        }
        monitor.start();
        const measuredStart = Date.now();

        const results = await runPool(queue, parallelism, async (workerId) => {
            const client = await connectCdp(endpoint, 8000);
            const { browserContextId } = await client.send("Target.createBrowserContext", {});
            const { targetId } = await client.send("Target.createTarget", {
                url: "about:blank",
                browserContextId,
            });
            const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
            await client.send("Page.enable", {}, sessionId);
            await client.send("Runtime.enable", {}, sessionId);
            return {
                fetch: (item) => fetchPage(client, sessionId, item.url, opts.timeoutMs, opts.mode, opts.expressions, opts.pageWaitFor),
                close: async () => {
                    await client.send("Target.disposeBrowserContext", { browserContextId }).catch(() => {});
                    client.close();
                },
            };
        }, opts.interItemDelayMs ?? 0);
        const resources = monitor.stop(queue.length, parallelism);
        return summarize(results, Date.now() - measuredStart, parallelism, {
            engine: "velora",
            resources,
            httpCacheDir,
            parallelismModel: "multi-session-single-process",
            architectureNote: "Velora: 1 velora serve process; N CDP connections (1 browser context each); shared Network, HttpClient, and optional HTTP cache.",
            veloraMeasurementStack: "cdp-fetchPage",
        }, opts.benchmarkClass);
    } finally {
        if (proc.exitCode == null) {
            proc.kill("SIGTERM");
            await new Promise((r) => proc.once("exit", r));
        }
    }
}

function resolveChromePath(explicit) {
    if (explicit) return explicit;
    const { chromium } = require("playwright");
    return chromium.executablePath();
}

export async function crawlChromium(queue, opts) {
    const chromePath = resolveChromePath(opts.chromePath);
    const cdpPort = await getFreePort();
    const userDataDir = mkdtempSync(join(tmpdir(), "velora-wiki-chrome-"));
    const proc = spawn(chromePath, [
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${userDataDir}`,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--mute-audio",
        "--hide-scrollbars",
        "about:blank",
    ], { cwd: repoRoot, stdio: "ignore" });

    const parallelism = Math.max(1, Math.min(opts.concurrency, queue.length));
    const monitor = new ProcessMonitor({ label: "chromium", intervalMs: opts.sampleIntervalMs ?? 100 });
    monitor.addRootPid(proc.pid);

    try {
        const client = await connectCdp(`http://127.0.0.1:${cdpPort}`, 15000);
        if (opts.warmup) {
            console.log(`[warmup] Chromium → ${opts.warmupUrl ?? warmupUrlFor(opts.lang)}`);
            await preWarmupChromium(client, opts);
        }
        monitor.start();
        const measuredStart = Date.now();
        const results = await runPool(queue, parallelism, async (workerId) => {
            const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
            const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
            await client.send("Page.enable", {}, sessionId);
            await client.send("Runtime.enable", {}, sessionId);
            return {
                fetch: (item) => fetchPage(client, sessionId, item.url, opts.timeoutMs, opts.mode, opts.expressions, opts.pageWaitFor),
                close: async () => {
                    await client.send("Target.closeTarget", { targetId }).catch(() => {});
                },
            };
        }, opts.interItemDelayMs ?? 0);
        client.close();
        const resources = monitor.stop(queue.length, parallelism);
        return summarize(results, Date.now() - measuredStart, parallelism, {
            engine: "chromium",
            chromePath,
            resources,
            parallelismModel: "multi-tab-single-process",
            architectureNote: "Chromium: N tabs in one browser; OS sees browser + renderer + GPU + network + utility processes.",
            chromiumMeasurementStack: "cdp-fetchPage",
        }, opts.benchmarkClass);
    } finally {
        if (proc.exitCode == null) {
            proc.kill("SIGTERM");
            await new Promise((r) => proc.once("exit", r));
        }
        try {
            rmSync(userDataDir, { recursive: true, force: true });
        } catch (_) {}
    }
}

export function collectMeta(opts) {
    let gitSha = null;
    try {
        gitSha = execSync("git rev-parse --short HEAD", { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] })
            .toString()
            .trim();
    } catch (_) {}

    const cpu = cpus()[0];
    const httpCacheDir = profileHttpCacheDir(opts);
    const lane = opts.benchmarkLane ?? (opts.veloraMultiProcess === false ? "fair" : "density");
    return {
        timestamp: new Date().toISOString(),
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        osRelease: release(),
        cpu: cpu ? `${cpu.model} (${cpus().length} cores)` : null,
        node: process.version,
        gitSha,
        site: `https://${opts.lang}.wikipedia.org/`,
        limit: opts.limit,
        concurrency: opts.concurrency,
        mode: opts.mode,
        veloraProfile: opts.browserProfile,
        chromiumTarget: "playwright-chromium-headless",
        benchmarkClass: "crawler-runtime",
        benchmarkLane: lane,
        benchmarkName: opts.benchmarkName ?? "Real-world crawl benchmark",
        veloraMultiProcess: opts.veloraMultiProcess !== false,
        warmup: opts.warmup === true,
        warmupUrl: opts.warmup ? (opts.warmupUrl ?? warmupUrlFor(opts.lang)) : null,
        httpCacheDir,
        httpCacheEnabled: httpCacheDir != null,
        veloraMeasurementStack: "cdp-fetchPage",
        chromiumMeasurementStack: "cdp-fetchPage",
        benchmarkAssumptions: lane === "fair"
            ? BENCHMARK_ASSUMPTIONS.crawlFair
            : BENCHMARK_ASSUMPTIONS.crawlDensity,
        ...veloraBuildMetaForReport(),
    };
}

export function loadOrFetchTitles(opts) {
    if (opts.titlesFile && existsSync(opts.titlesFile)) {
        const data = JSON.parse(readFileSync(opts.titlesFile, "utf8"));
        return data.titles.slice(0, opts.limit);
    }
    return null;
}

export function saveTitles(path, lang, titles) {
    const dir = resolve(path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify({ lang, fetchedAt: new Date().toISOString(), titles }, null, 2)}\n`);
}