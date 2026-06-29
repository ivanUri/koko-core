#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const CREEPJS_URL = "https://abrahamjuliot.github.io/creepjs/";
const CHROME_PORT = 9336;
const CHROME_PROFILE = resolve(os.tmpdir(), "creepjs-chrome-webgl");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const chromeExecutable = () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function freePort() {
    return new Promise((res, rej) => {
        const s = createServer();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
    });
}

async function waitCdp(endpoint, ms = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) return; } catch {}
        await delay(100);
    }
    throw new Error(`CDP not ready: ${endpoint}`);
}

class Cdp {
    constructor(ws) {
        this.ws = ws; this.id = 1; this.pending = new Map();
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

const EXTRACT = `(() => {
    const w = window.Fingerprint?.canvasWebgl;
    if (!w) return null;
    const mini = (x) => {
        if (x == null) return null;
        let h = 0;
        const s = typeof x === "string" ? x : JSON.stringify(x);
        for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        return h;
    };
    return {
        hash: w.$hash,
        dataURIMini: mini(w.dataURI),
        dataURI2Mini: mini(w.dataURI2),
        pixelsLen: w.pixels?.length ?? 0,
        pixels2Len: w.pixels2?.length ?? 0,
        pixelsMini: mini(w.pixels),
        pixels2Mini: mini(w.pixels2),
        gpuMini: mini(w.gpu),
        extensionsLen: w.extensions?.length ?? 0,
        extensionsMini: mini(w.extensions),
        parametersMini: mini(w.parameters),
        parametersKeys: w.parameters ? Object.keys(w.parameters).length : 0,
        lied: w.lied,
        fullMini: mini(w),
    };
})()`;

async function captureCdp(endpoint, { navigate = false, maxSec = 20 } = {}) {
    const ver = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.on("open", r); ws.on("error", j); });
    const cdp = new Cdp(ws);
    let sid = null;
    if (navigate) {
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        ({ sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
        await cdp.send("Page.enable", {}, sid);
        await cdp.send("Runtime.enable", {}, sid);
        await cdp.send("Page.navigate", { url: CREEPJS_URL }, sid);
    } else {
        const pages = await (await fetch(`${endpoint}/json/list`)).json();
        const tab = pages.find((p) => p.url?.includes("creepjs"));
        cdp.close();
        const ws2 = new WebSocket(tab.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws2.on("open", r); ws2.on("error", j); });
        const cdp2 = new Cdp(ws2);
        await cdp2.send("Page.enable");
        await cdp2.send("Runtime.enable");
        Object.assign(cdp, { ws: ws2, send: (...a) => cdp2.send(...a), close: () => ws2.close() });
    }
    const t0 = Date.now();
    for (let i = 0; i < maxSec * 2 && Date.now() - t0 < maxSec * 1000; i += 1) {
        await delay(500);
        const r = await cdp.send("Runtime.evaluate", { expression: EXTRACT, returnByValue: true, awaitPromise: true }, sid);
        if (r.result?.value) { cdp.close(); return r.result.value; }
    }
    cdp.close();
    throw new Error("timeout");
}

async function main() {
    const profile = process.argv[2] ?? "chrome-local-huys-macbook-pro";
    const chromeProc = spawn(chromeExecutable(), [
        `--remote-debugging-port=${CHROME_PORT}`, `--user-data-dir=${CHROME_PROFILE}`,
        "--no-first-run", "--no-default-browser-check", CREEPJS_URL,
    ], { stdio: "ignore" });
    await waitCdp(`http://127.0.0.1:${CHROME_PORT}`);
    const chrome = await captureCdp(`http://127.0.0.1:${CHROME_PORT}`, { navigate: false });
    chromeProc.kill("SIGKILL");

    const port = await freePort();
    const veloraProc = spawn(VELORA_BIN, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", profile, "--log-level", "warn",
    ], { cwd: REPO, stdio: "ignore" });
    await waitCdp(`http://127.0.0.1:${port}`);
    const velora = await captureCdp(`http://127.0.0.1:${port}`, { navigate: true });
    veloraProc.kill("SIGKILL");

    console.log("Chrome:", chrome);
    console.log("Velora:", velora);
    for (const k of Object.keys(chrome)) {
        console.log(chrome[k] === velora[k] ? `OK ${k}` : `DIFF ${k} C=${chrome[k]} V=${velora[k]}`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });