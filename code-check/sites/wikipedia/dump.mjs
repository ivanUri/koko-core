#!/usr/bin/env node
// Crawl N random Wikipedia articles in parallel using Velora.
//
// Velora currently supports only one BrowserContext per process, so we get
// real concurrency by spawning multiple `velora serve` instances. Each
// instance is a worker that pulls titles off a shared queue, navigates to
// the article, extracts `document.documentElement.outerHTML`, and writes the
// HTML to `<out>/<slug>.html`.
//
// Usage:
//   node code-check/sites/wikipedia/dump.mjs [--limit 100] [--concurrency 8]
//                                     [--out code-check/tmp/wikipedia-dump]
//                                     [--lang en] [--timeout 30000]
//                                     [--keep-log]

const { spawn } = require("node:child_process");
const net = require("node:net");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");

const defaults = {
    limit: 100,
    concurrency: 8,
    out: resolve(repoRoot, "code-check/tmp/wikipedia-dump"),
    lang: "en",
    timeoutMs: 30000,
    logLevel: "warn",
    keepLog: false,
};

function parseArgs(argv) {
    const opts = { ...defaults };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        switch (a) {
            case "--limit": opts.limit = Number(next()); break;
            case "--concurrency": opts.concurrency = Number(next()); break;
            case "--out": opts.out = resolve(next()); break;
            case "--lang": opts.lang = next(); break;
            case "--timeout": opts.timeoutMs = Number(next()); break;
            case "--log-level": opts.logLevel = next(); break;
            case "--keep-log": opts.keepLog = true; break;
            case "--help":
                console.log(`Usage: node wikipedia-dump.js [options]
  --limit N           number of articles to fetch (default 100)
  --concurrency N     parallel velora processes (default 8)
  --out DIR           output directory (default code-check/tmp/wikipedia-dump)
  --lang CODE         wikipedia language (default en)
  --timeout MS        per-page navigation timeout (default 30000)
  --log-level LEVEL   velora log level (default warn)
  --keep-log          keep velora stderr per worker
`);
                process.exit(0);
            default:
                console.error(`Unknown arg: ${a}`);
                process.exit(2);
        }
    }
    return opts;
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

function slugify(title) {
    return title
        .replace(/[\\/:*?"<>|]+/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .slice(0, 180) || "untitled";
}

async function getFreePort() {
    return new Promise((res, rej) => {
        const s = net.createServer();
        s.unref();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
    });
}

async function waitFor(url, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try { const r = await fetch(url); if (r.ok) return; } catch (_) {}
        await delay(50);
    }
    throw new Error(`waitFor timed out: ${url}`);
}

async function fetchRandomTitles(lang, limit) {
    const titles = [];
    const seen = new Set();
    const apiBase = `https://${lang}.wikipedia.org/w/api.php`;
    while (titles.length < limit) {
        const chunk = Math.min(500, limit - titles.length);
        const url = `${apiBase}?action=query&list=random&rnnamespace=0&rnlimit=${chunk}&format=json&origin=*`;
        const res = await fetch(url, { headers: { "user-agent": "velora-wikipedia-dump/1.0" } });
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

class CdpClient {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        this.eventListeners = new Map();
        this.closed = false;
        ws.addEventListener("close", () => {
            this.closed = true;
            for (const p of this.pending.values()) p.reject(new Error("ws closed"));
            this.pending.clear();
        });
        ws.addEventListener("message", (ev) => this._onMessage(ev));
    }
    _onMessage(ev) {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
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
        if (!list) { list = []; this.eventListeners.set(key, list); }
        list.push(cb);
        return () => {
            const i = list.indexOf(cb);
            if (i >= 0) list.splice(i, 1);
        };
    }
    send(method, params = {}, sessionId, timeoutMs = 30000) {
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
                resolve: (v) => { clearTimeout(timer); res(v); },
                reject: (e) => { clearTimeout(timer); rej(e); },
            });
            this.ws.send(JSON.stringify(payload));
        });
    }
}

// Spawn one velora process, attach via CDP, return { proc, client, sessionId, kill }.
async function startWorker(opts, workerIdx) {
    const port = await getFreePort();
    const veloraArgs = [
        "serve",
        "--host", "127.0.0.1",
        "--port", String(port),
        "--log-level", opts.logLevel,
        "--log-format", "pretty",
        "--http-timeout", String(opts.timeoutMs),
    ];
    const stderrChunks = [];
    const proc = spawn(veloraBin, veloraArgs, {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "pipe"],
    });
    let exited = null;
    proc.on("exit", (code, signal) => { exited = { code, signal }; });
    proc.stderr.on("data", (c) => stderrChunks.push(c));

    await waitFor(`http://127.0.0.1:${port}/json/version`, 5000);
    const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(v.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", rej, { once: true });
    });
    const client = new CdpClient(ws);

    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);

    const kill = async () => {
        try { ws.close(); } catch (_) {}
        if (!exited) {
            proc.kill("SIGTERM");
            await new Promise((r) => proc.once("exit", r));
        }
        if (opts.keepLog) {
            writeFileSync(resolve(opts.out, `velora-w${workerIdx}.log`),
                Buffer.concat(stderrChunks).toString());
        }
    };

    return { idx: workerIdx, port, proc, client, sessionId, kill, exited: () => exited };
}

async function fetchAndSave(worker, url, title, timeoutMs, outDir) {
    const loadOnce = new Promise((res) => {
        const off = worker.client.onEvent("Page.loadEventFired", worker.sessionId, () => { off(); res(); });
    });
    const nav = await worker.client.send("Page.navigate", { url }, worker.sessionId, timeoutMs);
    if (nav.errorText) throw new Error(`navigate error: ${nav.errorText}`);
    // Best-effort wait for the load event; fall through if it does not fire
    // within a short window (Wikipedia keeps third-party trackers chatty).
    await Promise.race([loadOnce, delay(Math.min(timeoutMs, 10000))]);
    const evalRes = await worker.client.send("Runtime.evaluate", {
        expression: "document.documentElement && document.documentElement.outerHTML",
        returnByValue: true,
        timeout: timeoutMs,
    }, worker.sessionId, timeoutMs);
    const html = evalRes?.result?.value;
    if (typeof html !== "string" || html.length < 200) {
        throw new Error(`empty html (len=${html?.length ?? -1})`);
    }
    const file = resolve(outDir, `${slugify(title)}.html`);
    writeFileSync(file, html);
    return { file, bytes: html.length };
}

async function main() {
    const opts = parseArgs(process.argv);

    if (!existsSync(veloraBin)) {
        console.error(`velora binary not found: ${veloraBin}`);
        console.error("build first: zig build -Doptimize=ReleaseFast -Dsnapshot_path=../../snapshot.bin");
        process.exit(1);
    }
    if (!existsSync(opts.out)) mkdirSync(opts.out, { recursive: true });

    console.log(`[wiki] fetching ${opts.limit} random ${opts.lang}.wikipedia titles…`);
    const t0 = Date.now();
    const titles = await fetchRandomTitles(opts.lang, opts.limit);
    console.log(`[wiki] got ${titles.length} titles in ${Date.now() - t0}ms`);

    const concurrency = Math.max(1, Math.min(opts.concurrency, titles.length));
    console.log(`[wiki] spawning ${concurrency} velora workers…`);

    const startWorkers = Date.now();
    const workers = [];
    try {
        // Spawn workers in parallel (each binds its own port).
        const created = await Promise.allSettled(
            Array.from({ length: concurrency }, (_, i) => startWorker(opts, i)),
        );
        for (const r of created) {
            if (r.status === "fulfilled") workers.push(r.value);
            else console.error(`[wiki] worker spawn failed: ${r.reason?.message ?? r.reason}`);
        }
        if (workers.length === 0) throw new Error("no workers started");
        console.log(`[wiki] ${workers.length} workers ready in ${Date.now() - startWorkers}ms`);

        const queue = titles.map((title, i) => ({
            i,
            title,
            url: `https://${opts.lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
        }));
        let nextIdx = 0;
        const results = [];

        const startAll = Date.now();
        const runWorker = async (worker) => {
            while (true) {
                if (worker.exited()) {
                    console.log(`  [w${worker.idx}] worker exited unexpectedly, stopping`);
                    return;
                }
                const idx = nextIdx++;
                if (idx >= queue.length) return;
                const item = queue[idx];
                const t = Date.now();
                try {
                    const res = await fetchAndSave(worker, item.url, item.title, opts.timeoutMs, opts.out);
                    const ms = Date.now() - t;
                    results.push({ ok: true, idx: item.i, title: item.title, ms, bytes: res.bytes, worker: worker.idx });
                    console.log(`  [w${worker.idx}] (${results.length}/${titles.length}) ${item.title} — ${ms}ms, ${(res.bytes / 1024).toFixed(1)}KiB`);
                } catch (err) {
                    const ms = Date.now() - t;
                    results.push({ ok: false, idx: item.i, title: item.title, ms, error: err.message, worker: worker.idx });
                    console.log(`  [w${worker.idx}] (${results.length}/${titles.length}) ${item.title} — FAIL ${ms}ms: ${err.message}`);
                }
            }
        };
        await Promise.all(workers.map(runWorker));
        const totalMs = Date.now() - startAll;

        const ok = results.filter((r) => r.ok);
        const fail = results.filter((r) => !r.ok);
        const totalBytes = ok.reduce((s, r) => s + r.bytes, 0);
        const meanMs = ok.length ? Math.round(ok.reduce((s, r) => s + r.ms, 0) / ok.length) : 0;
        console.log("\n=== summary ===");
        console.log(`workers:    ${workers.length}`);
        console.log(`success:    ${ok.length}/${results.length}`);
        console.log(`failed:     ${fail.length}`);
        console.log(`wall time:  ${totalMs}ms`);
        console.log(`per-page:   mean ${meanMs}ms (single-worker latency)`);
        console.log(`throughput: ${(results.length / (totalMs / 1000)).toFixed(2)} pages/sec`);
        console.log(`output dir: ${opts.out}`);
        console.log(`total html: ${(totalBytes / 1024 / 1024).toFixed(2)} MiB`);
        if (fail.length) {
            console.log("\nfirst 10 failures:");
            for (const f of fail.slice(0, 10)) {
                console.log(`  - ${f.title}: ${f.error}`);
            }
        }

        writeFileSync(resolve(opts.out, "_index.json"), JSON.stringify({
            generated_at: new Date().toISOString(),
            lang: opts.lang,
            limit: opts.limit,
            concurrency: workers.length,
            total_ms: totalMs,
            ok: ok.length,
            fail: fail.length,
            results,
        }, null, 2));
    } catch (err) {
        console.error("[wiki] error:", err.message);
        process.exitCode = 1;
    } finally {
        console.log("[wiki] shutting down workers…");
        await Promise.all(workers.map((w) => w.kill().catch(() => {})));
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
