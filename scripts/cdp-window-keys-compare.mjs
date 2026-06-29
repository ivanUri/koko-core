#!/usr/bin/env node
/** Diff CreepJS windowFeatures.keys Chrome vs Velora (sequential, max 20s each). */
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
const OUT = resolve(REPO, "code-check/tmp/window-keys-compare.json");
const MAX_SEC = DEFAULT_MAX_SEC;
const TOTAL_BUDGET_SEC = MAX_SEC * 2 + 5;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const READY = `(() => {
    const header = document.querySelector(".fingerprint-header")?.innerText
        ?? document.getElementById("creep-fingerprint")?.innerText ?? "";
    return /FP ID:\\s*[0-9a-f]{8,}/i.test(header);
})()`;

const EXTRACT = `(() => {
    const wf = window.Fingerprint?.windowFeatures;
    if (wf?.keys?.length) {
        return {
            keys: wf.keys,
            apple: wf.apple,
            moz: wf.moz,
            webkit: wf.webkit,
        };
    }
    const keys = Object.getOwnPropertyNames(window).filter((k) => !/_|\\d{3,}/.test(k));
    return {
        keys,
        apple: keys.filter((k) => /apple/i.test(k)).length,
        moz: keys.filter((k) => /moz/i.test(k)).length,
        webkit: keys.filter((k) => /webkit/i.test(k)).length,
    };
})()`;

async function waitCdp(endpoint, ms = 15_000) {
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

async function keysFrom(label, endpoint, { navigate, deadline }) {
    const t0 = Date.now();
    let cdp;
    let sid = null;

    if (navigate) {
        const version = await (await fetch(`${endpoint}/json/version`)).json();
        const ws = new WebSocket(version.webSocketDebuggerUrl);
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
        const ws = new WebSocket(tab.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
        cdp = new Cdp(ws);
        await cdp.send("Runtime.enable");
    }

    let data = null;
    while (Date.now() < deadline) {
        await delay(400);
        const ready = await evaluateWithTimeout(cdp, sid, READY, Math.min(5000, deadline - Date.now()));
        if (ready.timedOut || ready.error || !ready.value) continue;
        const r = await evaluateWithTimeout(cdp, sid, EXTRACT, Math.min(5000, deadline - Date.now()));
        if (r.timedOut || r.error || !r.value?.keys?.length) continue;
        data = r.value;
        break;
    }
    cdp.close();
    if (!data) throw new Error(`[HANG] ${label} window keys exceeded ${MAX_SEC}s`);
    return { elapsedMs: Date.now() - t0, ...data };
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

try {
    const chromeProfile = resolve(os.tmpdir(), `window-keys-chrome-${process.pid}`);
    const chromePort = await freePort();
    chromeProc = spawn(chromeExecutable(), [
        `--remote-debugging-port=${chromePort}`,
        `--user-data-dir=${chromeProfile}`,
        "--no-first-run",
        "--no-default-browser-check",
        CREEPJS_URL,
    ], { stdio: "ignore" });

    let chrome;
    try {
        await waitCdp(`http://127.0.0.1:${chromePort}`, budget.remaining());
        chrome = await keysFrom("chrome", `http://127.0.0.1:${chromePort}`, {
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
        velora = await keysFrom("velora", `http://127.0.0.1:${veloraPort}`, {
            navigate: true,
            deadline: Date.now() + MAX_SEC * 1000,
        });
    } finally {
        killProcess(veloraProc);
    }

    const cSet = new Set(chrome.keys);
    const vSet = new Set(velora.keys);
    const onlyChrome = chrome.keys.filter((k) => !vSet.has(k));
    const onlyVelora = velora.keys.filter((k) => !cSet.has(k));
    const report = {
        at: new Date().toISOString(),
        chrome: { len: chrome.keys.length, apple: chrome.apple, moz: chrome.moz, webkit: chrome.webkit, elapsedMs: chrome.elapsedMs },
        velora: { len: velora.keys.length, apple: velora.apple, moz: velora.moz, webkit: velora.webkit, elapsedMs: velora.elapsedMs },
        onlyChrome,
        onlyVelora,
    };
    await writeFile(OUT, JSON.stringify(report, null, 2));
    console.log(`chrome=${chrome.keys.length} velora=${velora.keys.length} onlyC=${onlyChrome.length} onlyV=${onlyVelora.length}`);
    for (const k of onlyChrome.slice(0, 20)) console.log(`  +C ${k}`);
    for (const k of onlyVelora.slice(0, 20)) console.log(`  +V ${k}`);
    console.log(`saved ${OUT}`);
} catch (err) {
    if (String(err?.message || err).includes("[HANG]")) budget.failHang("window-keys", String(err.message || err));
    throw err;
} finally {
    budget.clear();
    killProcess(chromeProc);
    killProcess(veloraProc);
}