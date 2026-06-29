#!/usr/bin/env node
/** Compare full workerScope payload Chrome vs Velora (max 20s). */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import WebSocket from "ws";
import {
    createProbeBudget,
    evaluateWithTimeout,
    fetchWithTimeout,
    killProcess,
    waitCdp as waitCdpBudget,
    DEFAULT_MAX_SEC,
} from "./lib/cdp-probe-budget.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const CREEPJS_URL = "https://abrahamjuliot.github.io/creepjs/";
const OUT = resolve(REPO, "code-check/tmp/worker-scope-field-compare.json");
const CHROME_PROFILE = resolve(os.tmpdir(), `creepjs-worker-field-chrome-${process.pid}`);
const MAX_SEC = DEFAULT_MAX_SEC;
const TOTAL_BUDGET_SEC = MAX_SEC * 2 + 5;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const READY = `(() => {
    const header = document.querySelector(".fingerprint-header")?.innerText
        ?? document.getElementById("creep-fingerprint")?.innerText ?? "";
    return /FP ID:\\s*[0-9a-f]{8,}/i.test(header);
})()`;

async function openWebSocket(url, timeoutMs = 8000) {
    const ws = new WebSocket(url);
    await Promise.race([
        new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); }),
        delay(timeoutMs).then(() => {
            ws.terminate?.();
            throw new Error(`WebSocket timeout: ${url}`);
        }),
    ]);
    return ws;
}

function chromeExecutable() {
    if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    return "google-chrome";
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
    close() {
        try { this.ws.close(); } catch {}
        for (const { reject } of this.pending.values()) {
            reject(new Error("CDP closed"));
        }
        this.pending.clear();
    }
}

const EXTRACT = `(() => {
    const ws = window.Fingerprint?.workerScope;
    if (!ws) return { ready: false };
    const omit = new Set(["$hash", "gpu"]);
    const out = {};
    for (const [k, v] of Object.entries(ws)) {
        if (omit.has(k)) continue;
        out[k] = v;
    }
    return { ready: true, workerScope: out };
})()`;

async function capture(label, endpoint, { navigate = true, deadline }) {
    const t0 = Date.now();
    let cdp;
    let sid = null;
    if (navigate) {
        const version = await fetchWithTimeout(`${endpoint}/json/version`, 5000).then((r) => r.json());
        const ws = await openWebSocket(version.webSocketDebuggerUrl);
        cdp = new Cdp(ws);
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        ({ sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
        await cdp.send("Page.enable", {}, sid);
        await cdp.send("Runtime.enable", {}, sid);
        await cdp.send("Page.navigate", { url: CREEPJS_URL }, sid);
    } else {
        const pages = await fetchWithTimeout(`${endpoint}/json/list`, 5000).then((r) => r.json());
        const tab = pages.find((p) => p.url?.includes("creepjs"));
        if (!tab?.webSocketDebuggerUrl) throw new Error(`${label}: creepjs tab not found`);
        const ws = await openWebSocket(tab.webSocketDebuggerUrl);
        cdp = new Cdp(ws);
        await cdp.send("Runtime.enable");
    }
    let data = null;
    while (Date.now() < deadline) {
        await delay(400);
        const remain = Math.max(1, deadline - Date.now());
        const ready = await evaluateWithTimeout(cdp, sid, READY, Math.min(5000, remain));
        if (ready.timedOut || ready.error || !ready.value) continue;
        const r = await evaluateWithTimeout(cdp, sid, EXTRACT, Math.min(5000, Math.max(1, deadline - Date.now())));
        if (r.timedOut || r.error || !r.value?.ready) continue;
        data = r.value;
        break;
    }
    try { cdp.close(); } catch {}
    if (!data) throw new Error(`[HANG] ${label} worker scope field compare exceeded ${MAX_SEC}s`);
    return { elapsedMs: Date.now() - t0, ...data };
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

if (!existsSync(VELORA_BIN)) {
    console.error("zig build first");
    process.exit(2);
}

await mkdir(OUT.replace(/\/[^/]+$/, ""), { recursive: true });

let chromeProc;
let veloraProc;
const budget = createProbeBudget(TOTAL_BUDGET_SEC, () => {
    killProcess(chromeProc);
    killProcess(veloraProc);
});

try {
    const chromePort = await freePort();
    chromeProc = spawn(chromeExecutable(), [
        `--remote-debugging-port=${chromePort}`,
        `--user-data-dir=${CHROME_PROFILE}`,
        "--no-first-run",
        "--no-default-browser-check",
        CREEPJS_URL,
    ], { stdio: "ignore" });

    let chrome;
    try {
        await waitCdpBudget(`http://127.0.0.1:${chromePort}`, budget.deadline);
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
        await waitCdpBudget(`http://127.0.0.1:${veloraPort}`, budget.deadline);
        velora = await capture("velora", `http://127.0.0.1:${veloraPort}`, {
            navigate: true,
            deadline: Date.now() + MAX_SEC * 1000,
        });
    } finally {
        killProcess(veloraProc);
    }

    const flatC = flatten(chrome.workerScope);
    const flatV = flatten(velora.workerScope);
    const diffs = diffFlat(flatC, flatV);
    const report = { at: new Date().toISOString(), chrome, velora, diffs };
    await writeFile(OUT, JSON.stringify(report, null, 2));
    console.log(`diffs: ${diffs.length}`);
    for (const d of diffs.slice(0, 30)) {
        console.log(`  ${d.key}: C=${JSON.stringify(d.chrome)} V=${JSON.stringify(d.velora)}`);
    }
    console.log(`saved ${OUT}`);
} catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes("[HANG]") || msg.includes("CDP not ready") || msg.includes("WebSocket timeout") || msg.includes("CDP timeout")) {
        budget.failHang("workerScope", msg);
    }
    throw err;
} finally {
    budget.clear();
    killProcess(chromeProc);
    killProcess(veloraProc);
}