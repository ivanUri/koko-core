#!/usr/bin/env node
/** Full clientRects field diff (sequential, max 20s each). */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import WebSocket from "ws";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VELORA = resolve(REPO, "zig-out/bin/velora");
const CREEPJS = "https://abrahamjuliot.github.io/creepjs/";
const OUT = resolve(REPO, "code-check/tmp/clientrects-full-compare.json");
const MAX_SEC = 20;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPR = `(() => {
    const cr = window.Fingerprint?.clientRects;
    if (!cr?.elementClientRects?.length) return null;
    return {
        emojiSet: cr.emojiSet,
        domrectSystemSum: cr.domrectSystemSum,
        elementClientRects: cr.elementClientRects,
        rangeClientRects: cr.rangeClientRects,
        rangeBoundingClientRect: cr.rangeBoundingClientRect,
    };
})()`;

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
                if (msg.error) reject(new Error(msg.error.message));
                else resolve(msg.result);
            }
        });
    }
    send(method, params = {}, sid = null) {
        const id = this.id++;
        const payload = { id, method, params };
        if (sid) payload.sessionId = sid;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(payload));
        });
    }
    close() { this.ws.close(); }
}

async function waitCdp(url) {
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
        try { if ((await fetch(`${url}/json/version`)).ok) return; } catch {}
        await delay(100);
    }
    throw new Error(`CDP timeout ${url}`);
}

async function captureVelora() {
    const port = await new Promise((res, rej) => {
        const s = createServer();
        s.listen(0, "127.0.0.1", () => res(s.address().port));
        s.on("error", rej);
    });
    const proc = spawn(VELORA, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-local-huys-macbook-pro", "--log-level", "warn",
    ], { stdio: "ignore", cwd: REPO });
    try {
        await waitCdp(`http://127.0.0.1:${port}`);
        const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        const ws = new WebSocket(ver.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
        const cdp = new Cdp(ws);
        const t0 = Date.now();
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        const { sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
        await cdp.send("Page.enable", {}, sid);
        await cdp.send("Runtime.enable", {}, sid);
        await cdp.send("Page.navigate", { url: CREEPJS }, sid);
        let data = null;
        while (Date.now() - t0 < MAX_SEC * 1000) {
            await delay(500);
            const r = await cdp.send("Runtime.evaluate", { expression: EXPR, returnByValue: true }, sid);
            if (r.result?.value) { data = r.result.value; break; }
        }
        cdp.close();
        if (!data) throw new Error("[HANG] velora");
        return data;
    } finally {
        proc.kill("SIGKILL");
    }
}

async function captureChrome() {
    const port = 9361;
    const profile = resolve(os.tmpdir(), "cr-full-chrome");
    const proc = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
        `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", CREEPJS,
    ], { stdio: "ignore" });
    try {
        await waitCdp(`http://127.0.0.1:${port}`);
        const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const ws = new WebSocket(pages[0].webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
        const cdp = new Cdp(ws);
        await cdp.send("Runtime.enable");
        const t0 = Date.now();
        let data = null;
        while (Date.now() - t0 < MAX_SEC * 1000) {
            await delay(400);
            const r = await cdp.send("Runtime.evaluate", { expression: EXPR, returnByValue: true });
            if (r.result?.value) { data = r.result.value; break; }
        }
        cdp.close();
        if (!data) throw new Error("[HANG] chrome");
        return data;
    } finally {
        proc.kill("SIGKILL");
    }
}

const chrome = await captureChrome();
const velora = await captureVelora();
const diffs = [];
if (JSON.stringify(chrome.emojiSet) !== JSON.stringify(velora.emojiSet)) {
    const onlyC = chrome.emojiSet.filter((e) => !velora.emojiSet.includes(e));
    const onlyV = velora.emojiSet.filter((e) => !chrome.emojiSet.includes(e));
    diffs.push({ field: "emojiSet", onlyChrome: onlyC, onlyVelora: onlyV });
}
if (chrome.domrectSystemSum !== velora.domrectSystemSum) diffs.push({ field: "domrectSystemSum", chrome: chrome.domrectSystemSum, velora: velora.domrectSystemSum });
for (let i = 0; i < chrome.elementClientRects.length; i++) {
    if (JSON.stringify(chrome.elementClientRects[i]) !== JSON.stringify(velora.elementClientRects[i])) {
        diffs.push({ field: `elementClientRects[${i}]`, chrome: chrome.elementClientRects[i], velora: velora.elementClientRects[i] });
    }
}
for (let i = 0; i < chrome.rangeClientRects.length; i++) {
    if (JSON.stringify(chrome.rangeClientRects[i]) !== JSON.stringify(velora.rangeClientRects[i])) {
        diffs.push({ field: `rangeClientRects[${i}]`, chrome: chrome.rangeClientRects[i], velora: velora.rangeClientRects[i] });
    }
}
await writeFile(OUT, JSON.stringify({ diffs, chrome, velora }, null, 2));
console.log(`diffs=${diffs.length}`);
for (const d of diffs.slice(0, 20)) console.log(`  ${d.field}`);
console.log(`saved ${OUT}`);