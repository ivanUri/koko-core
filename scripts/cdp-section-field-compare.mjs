#!/usr/bin/env node
/** Field-level diff for clientRects / features / workerScope (sequential, max 20s each). */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import WebSocket from "ws";
import {
    createProbeBudget,
    evaluateWithTimeout,
    killProcess,
    DEFAULT_MAX_SEC,
} from "./lib/cdp-probe-budget.mjs";


const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const CREEPJS_URL = "https://abrahamjuliot.github.io/creepjs/";
const CHROME_PROFILE = resolve(os.tmpdir(), `creepjs-field-chrome-${process.pid}`);
const MAX_SEC = DEFAULT_MAX_SEC;
const TOTAL_BUDGET_SEC = MAX_SEC * 2 + 5;
const SECTION = process.argv[2] || "workerScope";

const OUT = resolve(REPO, `code-check/tmp/section-field-compare-${SECTION}.json`);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const READY = `(() => {
    const header = document.querySelector(".fingerprint-header")?.innerText
        ?? document.getElementById("creep-fingerprint")?.innerText ?? "";
    return /FP ID:\\s*[0-9a-f]{8,}/i.test(header);
})()`;

const EXTRACTORS = {
    workerScope: `(() => {
        const ws = window.Fingerprint?.workerScope;
        if (!ws) return null;
        const o = {};
        for (const [k, v] of Object.entries(ws)) if (k !== "$hash") o[k] = v;
        return o;
    })()`,
    clientRects: `(() => {
        const cr = window.Fingerprint?.clientRects;
        if (!cr?.elementClientRects?.length) return null;
        return {
            emojiSet: cr.emojiSet,
            domrectSystemSum: cr.domrectSystemSum,
            lied: cr.lied,
            elementClientRects: cr.elementClientRects,
            elementBoundingClientRect: cr.elementBoundingClientRect,
            rangeClientRects: cr.rangeClientRects,
            rangeBoundingClientRect: cr.rangeBoundingClientRect,
        };
    })()`,
    features: `(() => {
        const f = window.Fingerprint?.features;
        if (!f?.jsFeaturesKeys) return null;
        return {
            version: f.version,
            cssVersion: f.cssVersion,
            jsVersion: f.jsVersion,
            windowVersion: f.windowVersion,
            jsFeaturesKeys: f.jsFeaturesKeys,
            cssFeatures: [...(f.cssFeatures || [])],
            windowFeatures: [...(f.windowFeatures || [])],
            jsFeatures: [...(f.jsFeatures || [])],
        };
    })()`,
    navigator: `(() => {
        const n = window.Fingerprint?.navigator;
        if (!n?.platform) return null;
        const o = {};
        for (const [k, v] of Object.entries(n)) if (k !== "$hash") o[k] = v;
        return o;
    })()`,
    cssMedia: `(() => {
        const c = window.Fingerprint?.cssMedia;
        if (!c?.mediaCSS) return null;
        return {
            mediaCSS: c.mediaCSS,
            matchMediaCSS: c.matchMediaCSS,
            screenQuery: c.screenQuery,
        };
    })()`,
    screen: `(() => {
        const s = window.Fingerprint?.screen;
        if (!s?.width) return null;
        const o = {};
        for (const [k, v] of Object.entries(s)) if (k !== "$hash") o[k] = v;
        return o;
    })()`,
    css: `(() => {
        const c = window.Fingerprint?.css;
        if (!c?.computedStyle) return null;
        const o = {};
        for (const [k, v] of Object.entries(c)) if (k !== "$hash") o[k] = v;
        return o;
    })()`,
    fonts: `(() => {
        const f = window.Fingerprint?.fonts;
        if (!f?.fontFaceLoadFonts) return null;
        const o = {};
        for (const [k, v] of Object.entries(f)) if (k !== "$hash") o[k] = v;
        return o;
    })()`,
    maths: `(() => {
        const m = window.Fingerprint?.maths;
        if (!m?.data) return null;
        return { data: m.data, lied: m.lied };
    })()`,
    svg: `(() => {
        const s = window.Fingerprint?.svg;
        if (!s) return null;
        const o = {};
        for (const [k, v] of Object.entries(s)) if (k !== "$hash") o[k] = v;
        return o;
    })()`,
};

async function waitCdp(endpoint, ms = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) return; } catch {}
        await delay(100);
    }
    throw new Error(`CDP not ready: ${endpoint}`);
}

async function freePort() {
    return new Promise((res, rej) => {
        const s = createServer();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
    });
}

class Cdp {
    constructor(ws) {
        this.ws = ws;
        this.id = 1;
        this.pending = new Map();
        ws.on("message", (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                else resolve(msg.result);
            }
        });
    }
    send(method, params = {}, sid = null, timeoutMs = 10_000) {
        const id = this.id++;
        const payload = { id, method, params };
        if (sid) payload.sessionId = sid;
        return Promise.race([
            new Promise((resolve, reject) => {
                this.pending.set(id, { resolve, reject });
                this.ws.send(JSON.stringify(payload));
            }),
            delay(timeoutMs).then(() => {
                this.pending.delete(id);
                throw new Error(`CDP timeout: ${method}`);
            }),
        ]);
    }
    close() { this.ws.close(); }
}

async function capture(label, endpoint, { navigate, deadline }) {
    const expr = EXTRACTORS[SECTION];
    if (!expr) throw new Error(`unknown section: ${SECTION}`);
    const t0 = Date.now();
    let ws;
    let cdp;
    let sid = null;

    if (navigate) {
        const version = await (await fetch(`${endpoint}/json/version`)).json();
        ws = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
        cdp = new Cdp(ws);
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        ({ sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
        await cdp.send("Page.enable", {}, sid);
        await cdp.send("Runtime.enable", {}, sid);
        await cdp.send("Page.navigate", { url: CREEPJS_URL }, sid);
    } else {
        const pages = await (await fetch(`${endpoint}/json/list`)).json();
        const tab = pages.find((p) => p.url?.includes("creepjs"));
        if (!tab?.webSocketDebuggerUrl) throw new Error(`${label}: creepjs tab not found`);
        ws = new WebSocket(tab.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
        cdp = new Cdp(ws);
        await cdp.send("Runtime.enable");
    }

    let data = null;
    while (Date.now() < deadline) {
        await delay(400);
        const ready = await evaluateWithTimeout(cdp, sid, READY, Math.min(5000, deadline - Date.now()));
        if (ready.timedOut || ready.error || !ready.value) continue;
        const r = await evaluateWithTimeout(cdp, sid, expr, Math.min(5000, deadline - Date.now()));
        if (r.timedOut || r.error) continue;
        if (r.value) { data = r.value; break; }
    }
    cdp.close();
    if (!data) throw new Error(`[HANG] ${label} ${SECTION} exceeded ${MAX_SEC}s`);
    return { elapsedMs: Date.now() - t0, data };
}

function flatten(obj, prefix = "") {
    const out = {};
    if (obj == null || typeof obj !== "object") return out;
    for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v)) Object.assign(out, flatten(v, key));
        else out[key] = v;
    }
    return out;
}

function diffFlat(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const diffs = [];
    for (const k of [...keys].sort()) {
        const va = JSON.stringify(a[k]);
        const vb = JSON.stringify(b[k]);
        if (va !== vb) diffs.push({ key: k, chrome: a[k], velora: b[k] });
    }
    return diffs;
}

function chromeExecutable() {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}

if (!existsSync(VELORA_BIN)) {
    console.error("zig build first");
    process.exit(2);
}

await mkdir(resolve(REPO, "code-check/tmp"), { recursive: true });

let chromeProc;
let veloraProc;
const budget = createProbeBudget(TOTAL_BUDGET_SEC, () => {
    killProcess(chromeProc);
    killProcess(veloraProc);
});

const chromePort = await freePort();
chromeProc = spawn(chromeExecutable(), [
    `--remote-debugging-port=${chromePort}`,
    `--user-data-dir=${CHROME_PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    CREEPJS_URL,
], { stdio: "ignore" });

try {
    let chrome;
    try {
        await waitCdp(`http://127.0.0.1:${chromePort}`, budget.remaining());
        chrome = await capture("chrome", `http://127.0.0.1:${chromePort}`, {
            navigate: false,
            deadline: Date.now() + MAX_SEC * 1000,
        });
    } finally {
        killProcess(chromeProc);
    }

    const veloraPort = await freePort();
    veloraProc = spawn(VELORA_BIN, [
        "serve", "--host", "127.0.0.1", "--port", String(veloraPort),
        "--browser-profile", "chrome-local-huys-macbook-pro", "--log-level", "warn",
    ], { stdio: "ignore", cwd: REPO });

    let velora;
    try {
        await waitCdp(`http://127.0.0.1:${veloraPort}`, budget.remaining());
        velora = await capture("velora", `http://127.0.0.1:${veloraPort}`, {
            navigate: true,
            deadline: Date.now() + MAX_SEC * 1000,
        });
    } finally {
        killProcess(veloraProc);
    }

    const flatC = flatten(chrome.data);
    const flatV = flatten(velora.data);
    const diffs = diffFlat(flatC, flatV);
    const report = { at: new Date().toISOString(), section: SECTION, chrome, velora, diffs };
    await writeFile(OUT, JSON.stringify(report, null, 2));
    console.log(`section=${SECTION} diffs=${diffs.length}`);
    for (const d of diffs.slice(0, 50)) {
        const cv = JSON.stringify(d.chrome);
        const vv = JSON.stringify(d.velora);
        console.log(`  ${d.key}: C=${cv} V=${vv}`);
    }
    console.log(`saved ${OUT}`);
} catch (err) {
    if (String(err?.message || err).includes("[HANG]")) budget.failHang(SECTION, String(err.message || err));
    throw err;
} finally {
    budget.clear();
    killProcess(chromeProc);
    killProcess(veloraProc);
}