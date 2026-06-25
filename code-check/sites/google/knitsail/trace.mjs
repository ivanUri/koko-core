#!/usr/bin/env node
/**
 * Runtime trace: instrument host APIs while window.sgs(sp) executes.
 * Produces stable signal→access map for reverse engineering scoring formula.
 *
 * Usage:
 *   node code-check/sites/google/knitsail/trace.mjs
 *   node code-check/sites/google/knitsail/trace.mjs --dump ./dump.json
 *   node code-check/sites/google/knitsail/trace.mjs --compare  # Chrome + Velora
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../../sdk/dist/index.js";
import { connectChrome } from "../lib/chrome-cdp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const DEFAULT_DUMP = resolve(repoRoot, "code-check/tmp/knitsail-dump/dump.json");
const OUT = resolve(repoRoot, "code-check/tmp/knitsail-trace");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const TRACE_HOOK = `(() => {
    const root = window.top;
    const log = root.__knitsailTrace || (root.__knitsailTrace = []);

    const record = (kind, path, value) => {
        if (log.length >= 8000) return;
        log.push({
            t: performance.now(),
            kind,
            path,
            valueType: value === null ? "null" : typeof value,
            valuePreview: (() => {
                try {
                    if (typeof value === "function") return "[function]";
                    if (typeof value === "object") return value === null ? "null" : JSON.stringify(value).slice(0, 120);
                    return String(value).slice(0, 120);
                } catch (e) { return String(e); }
            })(),
        });
    };

    const wrapObject = (obj, path, depth = 0) => {
        if (!obj || typeof obj !== "object" || depth > 2) return obj;
        return new Proxy(obj, {
            get(target, prop) {
                if (typeof prop === "symbol") return target[prop];
                const full = path ? path + "." + String(prop) : String(prop);
                const val = target[prop];
                record("get", full, val);
                if (val && typeof val === "object") return wrapObject(val, full, depth + 1);
                if (typeof val === "function") {
                    return function (...args) {
                        record("call", full, null);
                        return val.apply(target, args);
                    };
                }
                return val;
            },
        });
    };

    // Shadow reads the VM is known to perform (SerpBase + bootstrap)
    const targets = [
        ["performance", performance],
        ["document", document],
        ["navigator", navigator],
        ["screen", screen],
        ["location", location],
        ["window.trustedTypes", window.trustedTypes],
        ["Math", Math],
    ];

    for (const [path, obj] of targets) {
        if (obj == null) continue;
        try {
            const parts = path.split(".");
            let cur = root;
            for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
            cur[parts[parts.length - 1]] = wrapObject(obj, path);
        } catch (e) {}
    }

    // performance.now samples
    const origNow = performance.now.bind(performance);
    let nowSamples = 0;
    performance.now = function () {
        const v = origNow();
        if (nowSamples < 500) {
            record("now", "performance.now", v);
            nowSamples += 1;
        }
        return v;
    };

    // Trap sgs call
    let sgsInner = root.sgs;
    Object.defineProperty(root, "sgs", {
        configurable: true,
        enumerable: true,
        get() { return sgsInner; },
        set(fn) {
            if (typeof fn !== "function") { sgsInner = fn; return; }
            sgsInner = function (...args) {
                record("call", "window.sgs", args[0] != null ? String(args[0]).slice(0, 80) : null);
                const p = fn.apply(this, args);
                if (p && p.then) {
                    return p.then(
                        (r) => { record("resolve", "window.sgs", r != null ? String(r).slice(0, 120) : null); return r; },
                        (e) => { record("reject", "window.sgs", String(e)); throw e; },
                    );
                }
                return p;
            };
        },
    });
})()`;

function summarizeTrace(entries) {
    const byPath = new Map();
    const kinds = new Map();
    const nowVals = [];

    for (const e of entries) {
        kinds.set(e.kind, (kinds.get(e.kind) || 0) + 1);
        if (e.path) byPath.set(e.path, (byPath.get(e.path) || 0) + 1);
        if (e.path === "performance.now" && e.kind === "now") {
            const v = Number(e.valuePreview);
            if (!Number.isNaN(v)) nowVals.push(v);
        }
    }

    let jitter = null;
    if (nowVals.length >= 3) {
        const deltas = [];
        for (let i = 1; i < nowVals.length; i++) deltas.push(nowVals[i] - nowVals[i - 1]);
        const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
        const var_ = deltas.reduce((a, b) => a + (b - avg) ** 2, 0) / deltas.length;
        jitter = { samples: nowVals.length, avgDelta: avg, variance: var_, min: Math.min(...deltas), max: Math.max(...deltas) };
    }

    const topPaths = [...byPath.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)
        .map(([path, count]) => ({ path, count }));

    return { total: entries.length, kinds: Object.fromEntries(kinds), topPaths, nowJitter: jitter };
}

function diffTraces(a, b) {
    const pathsA = new Set(a.topPaths.map((x) => x.path));
    const pathsB = new Set(b.topPaths.map((x) => x.path));
    const onlyA = [...pathsA].filter((p) => !pathsB.has(p));
    const onlyB = [...pathsB].filter((p) => !pathsA.has(p));
    const countDiffs = [];
    const mapB = new Map(b.topPaths.map((x) => [x.path, x.count]));
    for (const { path, count } of a.topPaths) {
        const ob = mapB.get(path);
        if (ob != null && ob !== count) countDiffs.push({ path, a: count, b: ob });
    }
    return { onlyA, onlyB, countDiffs, jitterA: a.nowJitter, jitterB: b.nowJitter };
}

async function getFreePort() {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.unref();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
    });
}

async function traceInBrowser(label, connect, query) {
    const search = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
    const { page, session, cleanup } = await connect();
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source: TRACE_HOOK });
    await page.goto(search, { waitUntil: "domcontentloaded", timeout: 90_000 });
    for (let i = 0; i < 120; i++) {
        try {
            const u = await page.evaluate(() => location.href);
            if (u.includes("sg_ss=") || u.includes("/sorry")) break;
            if (/SearchResultsPage/.test(await page.content().catch(() => ""))) break;
        } catch {}
        await delay(250);
    }
    await delay(2000);

    const payload = await page.evaluate(() => ({
        url: location.href,
        sorry: location.href.includes("/sorry"),
        serp: document.documentElement.innerHTML.includes("SearchResultsPage"),
        trace: window.__knitsailTrace || [],
        spLen: typeof sp !== "undefined" ? String(sp).length : 0,
        sgsResolved: (window.__knitsailTrace || []).some((e) => e.kind === "resolve" && e.path === "window.sgs"),
    }));
    await cleanup();
    return { label, query, search, ...payload, summary: summarizeTrace(payload.trace) };
}

async function traceChrome(query, chromeOpts = {}) {
    return traceInBrowser("chrome", async () => {
        const { browser } = await connectChrome(chromeOpts);
        const page = await browser.newPage();
        return {
            page,
            session: page.session,
            cleanup: async () => {
                await page.close().catch(() => undefined);
            },
        };
    }, query);
}

async function traceVelora(query) {
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-sonoma", "--log-level", "warn",
    ], { cwd: repoRoot, stdio: "ignore", env: { ...process.env, VELORA_ROOT: repoRoot } });
    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 60; i++) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {}
        await delay(100);
    }
    try {
        return await traceInBrowser("velora", async () => {
            const b = await Browser.connect(endpoint);
            const page = await b.newPage();
            return { page, session: page.session, cleanup: () => b.close() };
        }, query);
    } finally {
        proc.kill("SIGTERM");
    }
}

function parseArgs(argv) {
    const out = {
        dump: DEFAULT_DUMP,
        compare: false,
        query: `knitsail-trace-${Date.now()}`,
        cooldown: 30_000,
        spawnChrome: false,
        endpoint: undefined,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => { i += 1; return argv[i]; };
        if (a === "--dump") out.dump = resolve(next());
        else if (a === "--compare") out.compare = true;
        else if (a === "--query") out.query = next();
        else if (a === "--cooldown") out.cooldown = Number(next());
        else if (a === "--spawn-chrome") out.spawnChrome = true;
        else if (a === "--endpoint") out.endpoint = next();
    }
    return out;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    mkdirSync(OUT, { recursive: true });

    const results = [];
    if (opts.compare) {
        console.log("[trace] Chrome (real CDP)...");
        results.push(await traceChrome(opts.query, { spawn: opts.spawnChrome, endpoint: opts.endpoint }));
        console.log(`[cooldown] ${opts.cooldown}ms`);
        await delay(opts.cooldown);
        console.log("[trace] Velora...");
        results.push(await traceVelora(opts.query));
    } else {
        results.push(await traceChrome(opts.query));
    }

    const report = { query: opts.query, results };
    if (results.length === 2) {
        report.diff = diffTraces(results[0].summary, results[1].summary);
    }

    writeFileSync(resolve(OUT, "trace.json"), JSON.stringify(report, null, 2));

    for (const r of results) {
        console.log(`\n=== ${r.label} ===`);
        console.log(`outcome: ${r.sorry ? "sorry" : r.serp ? "SERP" : "other"}  sgsResolved=${r.sgsResolved}`);
        console.log(`trace entries: ${r.summary.total}`);
        console.log("top paths:");
        for (const p of r.summary.topPaths.slice(0, 15)) {
            console.log(`  ${p.count.toString().padStart(4)}  ${p.path}`);
        }
        if (r.summary.nowJitter) {
            const j = r.summary.nowJitter;
            console.log(`now jitter: samples=${j.samples} avgΔ=${j.avgDelta.toFixed(4)} var=${j.variance.toFixed(6)} min=${j.min.toFixed(4)} max=${j.max.toFixed(4)}`);
        }
    }

    if (report.diff) {
        console.log("\n=== Chrome vs Velora trace diff ===");
        if (report.diff.onlyA.length) console.log("only chrome:", report.diff.onlyA.slice(0, 20).join(", "));
        if (report.diff.onlyB.length) console.log("only velora:", report.diff.onlyB.slice(0, 20).join(", "));
        for (const d of report.diff.countDiffs.slice(0, 15)) {
            console.log(`  ${d.path}: chrome=${d.a} velora=${d.b}`);
        }
    }

    console.log(`\nsaved: ${OUT}/trace.json`);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});