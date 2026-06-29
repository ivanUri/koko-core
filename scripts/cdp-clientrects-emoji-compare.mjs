#!/usr/bin/env node
/** Compare clientRects emoji fields Chrome vs Velora (sequential, max 20s each). */
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
const OUT = resolve(REPO, "code-check/tmp/clientrects-emoji-compare.json");
const MAX_SEC = 20;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPR = `(() => {
    const cr = window.Fingerprint?.clientRects;
    if (!cr?.emojiSet) return null;
    return {
        emojiSetLen: cr.emojiSet.length,
        domrectSystemSum: cr.domrectSystemSum,
        emojiSet: cr.emojiSet,
        lied: cr.lied,
        e0: cr.elementClientRects?.[0],
        e3: cr.elementClientRects?.[3],
        range0: cr.rangeClientRects?.[0],
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
        if (!data) throw new Error("[HANG] velora clientRects");
        return data;
    } finally {
        proc.kill("SIGKILL");
    }
}

async function captureChrome() {
    const port = 9358;
    const profile = resolve(os.tmpdir(), "cr-emoji-chrome");
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
            await delay(300);
            const r = await cdp.send("Runtime.evaluate", { expression: EXPR, returnByValue: true });
            if (r.result?.value) { data = r.result.value; break; }
        }
        cdp.close();
        if (!data) throw new Error("[HANG] chrome clientRects");
        return data;
    } finally {
        proc.kill("SIGKILL");
    }
}

const chrome = await captureChrome();
const velora = await captureVelora();
const report = { chrome, velora, emojiOnlyChrome: chrome.emojiSet, emojiOnlyVelora: velora.emojiSet };
const missing = chrome.emojiSet.filter((e) => !velora.emojiSet.includes(e));
const extra = velora.emojiSet.filter((e) => !chrome.emojiSet.includes(e));
report.missingInVelora = missing;
report.extraInVelora = extra;
await writeFile(OUT, JSON.stringify(report, null, 2));
console.log(`chrome emojiSet=${chrome.emojiSetLen} sum=${chrome.domrectSystemSum}`);
console.log(`velora emojiSet=${velora.emojiSetLen} sum=${velora.domrectSystemSum}`);
console.log(`missing=${missing.length} extra=${extra.length}`);
if (missing.length) console.log("missing sample", missing.slice(0, 5));
if (extra.length) console.log("extra sample", extra.slice(0, 5));
console.log(`saved ${OUT}`);