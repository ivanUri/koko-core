#!/usr/bin/env node
// Crawl N random Wikipedia articles in parallel using headless Chrome.
//
// Mirrors `wikipedia-dump.js` (the Velora crawler) but exercises Chrome's
// native multi-tab concurrency: one chrome process, N targets/tabs sharing
// the binary, V8 isolate group, font/network caches. Each "worker" is a tab
// that pulls titles off a shared queue, navigates via CDP, awaits the load
// event, extracts `document.documentElement.outerHTML`, and writes the HTML
// to `<out>/<slug>.html`.
//
// Uses Playwright's bundled Chrome for Testing as the binary; no Playwright
// API is used — only its `executablePath()` helper. The CDP client is the
// same hand-rolled one used in the Velora script so the wait/extract logic
// is byte-identical, making the comparison fair.
//
// Usage:
//   node code-check/sites/wikipedia/dump-chrome.mjs [--limit 100] [--concurrency 8]
//                                            [--out code-check/tmp/wikipedia-dump-chrome]
//                                            [--lang en] [--timeout 30000]
//                                            [--chrome-path /path/to/chrome]
//                                            [--keep-log]

const { spawn } = require("node:child_process");
const net = require("node:net");
const { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { resolve, join } = require("node:path");

const repoRoot = resolve(__dirname, "../../..");

const defaults = {
    limit: 100,
    concurrency: 8,
    out: resolve(repoRoot, "code-check/tmp/wikipedia-dump-chrome"),
    lang: "en",
    timeoutMs: 30000,
    chromePath: null,
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
            case "--chrome-path": opts.chromePath = next(); break;
            case "--keep-log": opts.keepLog = true; break;
            case "--help":
                console.log(`Usage: node wikipedia-dump-chrome.js [options]
  --limit N           number of articles to fetch (default 100)
  --concurrency N     parallel chrome tabs (default 8)
  --out DIR           output directory (default code-check/tmp/wikipedia-dump-chrome)
  --lang CODE         wikipedia language (default en)
  --timeout MS        per-page navigation timeout (default 30000)
  --chrome-path PATH  chrome binary (default: playwright's bundled chromium)
  --keep-log          keep chrome stderr in <out>/chrome.log
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

function resolveChromePath(explicit) {
    if (explicit) return explicit;
    try {
        const { chromium } = require("playwright");
        return chromium.executablePath();
    } catch (_) {
        // Fall back to common system paths.
        const candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium",
        ];
        for (const p of candidates) if (existsSync(p)) return p;
        throw new Error("chrome not found; install playwright (`npm i -D playwright`) or pass --chrome-path");
    }
}

// One worker = one tab/target inside the shared chrome process. Each tab
// gets its own BrowserContext to mirror the per-worker isolation that the
// Velora script gets from per-process workers (separate cookie jar / cache).
// Drop the context isolation by passing useDefaultContext=true if you want
// to share network cache across workers (closer to "real" multi-tab UX).
async function createTab(client, idx, useDefaultContext) {
    let browserContextId;
    if (!useDefaultContext) {
        const r = await client.send("Target.createBrowserContext", { disposeOnDetach: true });
        browserContextId = r.browserContextId;
    }
    const params = { url: "about:blank" };
    if (browserContextId) params.browserContextId = browserContextId;
    const { targetId } = await client.send("Target.createTarget", params);
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);
    return { idx, browserContextId, targetId, sessionId };
}

async function fetchAndSave(client, tab, url, title, timeoutMs, outDir) {
    const loadOnce = new Promise((res) => {
        const off = client.onEvent("Page.loadEventFired", tab.sessionId, () => { off(); res(); });
    });
    const nav = await client.send("Page.navigate", { url }, tab.sessionId, timeoutMs);
    if (nav.errorText) throw new Error(`navigate error: ${nav.errorText}`);
    await Promise.race([loadOnce, delay(Math.min(timeoutMs, 10000))]);
    const evalRes = await client.send("Runtime.evaluate", {
        expression: "document.documentElement && document.documentElement.outerHTML",
        returnByValue: true,
        timeout: timeoutMs,
    }, tab.sessionId, timeoutMs);
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

    const chromePath = resolveChromePath(opts.chromePath);
    if (!existsSync(chromePath)) {
        console.error(`chrome binary not found: ${chromePath}`);
        process.exit(1);
    }
    if (!existsSync(opts.out)) mkdirSync(opts.out, { recursive: true });

    console.log(`[chrome] fetching ${opts.limit} random ${opts.lang}.wikipedia titles…`);
    const t0 = Date.now();
    const titles = await fetchRandomTitles(opts.lang, opts.limit);
    console.log(`[chrome] got ${titles.length} titles in ${Date.now() - t0}ms`);

    const cdpPort = await getFreePort();
    const userDataDir = mkdtempSync(join(tmpdir(), "wiki-chrome-"));
    console.log(`[chrome] launching ${chromePath}`);
    console.log(`[chrome]   --remote-debugging-port=${cdpPort}`);
    console.log(`[chrome]   --user-data-dir=${userDataDir}`);

    const stderrChunks = [];
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
    ], { cwd: repoRoot, stdio: ["ignore", "ignore", "pipe"] });

    let exited = null;
    proc.on("exit", (code, signal) => {
        exited = { code, signal };
        console.log(`\n[chrome exit] code=${code} signal=${signal}`);
    });
    proc.stderr.on("data", (c) => stderrChunks.push(c));

    const cleanup = async () => {
        if (opts.keepLog) {
            writeFileSync(resolve(opts.out, "chrome.log"), Buffer.concat(stderrChunks).toString());
            console.log(`[chrome] log saved: ${resolve(opts.out, "chrome.log")}`);
        }
        if (!exited) {
            proc.kill("SIGTERM");
            await new Promise((r) => proc.once("exit", r));
        }
        try { rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    };

    try {
        await waitFor(`http://127.0.0.1:${cdpPort}/json/version`, 10000);
        const v = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
        const ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
            ws.addEventListener("open", res, { once: true });
            ws.addEventListener("error", rej, { once: true });
        });
        const client = new CdpClient(ws);

        const concurrency = Math.max(1, Math.min(opts.concurrency, titles.length));
        console.log(`[chrome] opening ${concurrency} tabs…`);
        const tabsStart = Date.now();
        const tabs = await Promise.all(
            Array.from({ length: concurrency }, (_, i) => createTab(client, i, true)),
        );
        console.log(`[chrome] ${tabs.length} tabs ready in ${Date.now() - tabsStart}ms`);

        const queue = titles.map((title, i) => ({
            i,
            title,
            url: `https://${opts.lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
        }));
        let nextIdx = 0;
        const results = [];

        const startAll = Date.now();
        const runTab = async (tab) => {
            while (true) {
                const idx = nextIdx++;
                if (idx >= queue.length) return;
                const item = queue[idx];
                const t = Date.now();
                try {
                    const res = await fetchAndSave(client, tab, item.url, item.title, opts.timeoutMs, opts.out);
                    const ms = Date.now() - t;
                    results.push({ ok: true, idx: item.i, title: item.title, ms, bytes: res.bytes, worker: tab.idx });
                    console.log(`  [t${tab.idx}] (${results.length}/${titles.length}) ${item.title} — ${ms}ms, ${(res.bytes / 1024).toFixed(1)}KiB`);
                } catch (err) {
                    const ms = Date.now() - t;
                    results.push({ ok: false, idx: item.i, title: item.title, ms, error: err.message, worker: tab.idx });
                    console.log(`  [t${tab.idx}] (${results.length}/${titles.length}) ${item.title} — FAIL ${ms}ms: ${err.message}`);
                }
            }
        };
        await Promise.all(tabs.map(runTab));
        const totalMs = Date.now() - startAll;

        const ok = results.filter((r) => r.ok);
        const fail = results.filter((r) => !r.ok);
        const totalBytes = ok.reduce((s, r) => s + r.bytes, 0);
        const meanMs = ok.length ? Math.round(ok.reduce((s, r) => s + r.ms, 0) / ok.length) : 0;
        console.log("\n=== summary ===");
        console.log(`tabs:       ${tabs.length}`);
        console.log(`success:    ${ok.length}/${results.length}`);
        console.log(`failed:     ${fail.length}`);
        console.log(`wall time:  ${totalMs}ms`);
        console.log(`per-page:   mean ${meanMs}ms (single-tab latency)`);
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
            engine: "chrome",
            chrome_path: chromePath,
            lang: opts.lang,
            limit: opts.limit,
            concurrency: tabs.length,
            total_ms: totalMs,
            ok: ok.length,
            fail: fail.length,
            results,
        }, null, 2));

        ws.close();
    } catch (err) {
        console.error("[chrome] error:", err.message);
        process.exitCode = 1;
    } finally {
        await cleanup();
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
