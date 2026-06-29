#!/usr/bin/env node
/** Diff CreepJS features.jsFeaturesKeys Chrome vs Velora (sequential, max 20s each). */
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
const OUT = resolve(REPO, "code-check/tmp/features-keys-compare.json");
const MAX_SEC = 20;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const EXPR = `(() => {
    const f = window.Fingerprint?.features;
    if (!f?.jsFeaturesKeys) return null;
    return { jsFeaturesKeys: f.jsFeaturesKeys, jsFeatures: [...(f.jsFeatures||[])], jsVersion: f.jsVersion };
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
        if (!data) throw new Error("[HANG] velora features");
        return data;
    } finally {
        proc.kill("SIGKILL");
    }
}

async function captureChrome() {
    const port = 9360;
    const profile = resolve(os.tmpdir(), "features-keys-chrome");
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
        if (!data) throw new Error("[HANG] chrome features");
        return data;
    } finally {
        proc.kill("SIGKILL");
    }
}

const chrome = await captureChrome();
const velora = await captureVelora();
const cSet = new Set(chrome.jsFeaturesKeys);
const vSet = new Set(velora.jsFeaturesKeys);
const onlyC = chrome.jsFeaturesKeys.filter((k) => !vSet.has(k));
const onlyV = velora.jsFeaturesKeys.filter((k) => !cSet.has(k));
const report = { chrome: { len: chrome.jsFeaturesKeys.length }, velora: { len: velora.jsFeaturesKeys.length }, onlyChrome: onlyC, onlyVelora: onlyV };
await writeFile(OUT, JSON.stringify(report, null, 2));
console.log(`chrome=${chrome.jsFeaturesKeys.length} velora=${velora.jsFeaturesKeys.length} onlyC=${onlyC.length} onlyV=${onlyV.length}`);
for (const k of onlyC.slice(0, 15)) console.log(`  +C ${k}`);
for (const k of onlyV.slice(0, 15)) console.log(`  +V ${k}`);
console.log(`saved ${OUT}`);