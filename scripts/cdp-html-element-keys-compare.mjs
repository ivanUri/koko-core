#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import WebSocket from "ws";

const REPO = resolve(import.meta.dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const CREEPJS = "https://abrahamjuliot.github.io/creepjs/";
const CHROME_PORT = 9340;
const CHROME_PROFILE = resolve(os.tmpdir(), "html-keys-debug");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const chromeExecutable = () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function freePort() {
    return new Promise((res, rej) => {
        const s = createServer();
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
        s.on("error", rej);
    });
}

async function waitCdp(endpoint, ms = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try {
            if ((await fetch(`${endpoint}/json/version`)).ok) return;
        } catch {}
        await delay(100);
    }
    throw new Error("cdp timeout");
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
    close() {
        this.ws.close();
    }
}

const EXPR = `(() => {
    const keys = [];
    for (const k in document.documentElement) keys.push(k);
    return keys;
})()`;

async function keysFrom(endpoint, navigate, label) {
    const ver = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.on("open", res);
        ws.on("error", rej);
    });
    const cdp = new Cdp(ws);
    let sid = null;
    if (navigate) {
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        ({ sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
        await cdp.send("Page.enable", {}, sid);
        await cdp.send("Runtime.enable", {}, sid);
        await cdp.send("Page.navigate", { url: CREEPJS }, sid);
    } else {
        const pages = await (await fetch(`${endpoint}/json/list`)).json();
        const tab = pages.find((p) => p.url?.includes("creepjs"));
        cdp.close();
        const ws2 = new WebSocket(tab.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
            ws2.on("open", res);
            ws2.on("error", rej);
        });
        const cdp2 = new Cdp(ws2);
        await cdp2.send("Page.enable");
        await cdp2.send("Runtime.enable");
        Object.assign(cdp, { ws: ws2, send: (...a) => cdp2.send(...a), close: () => ws2.close() });
    }
    for (let i = 0; i < 40; i += 1) {
        await delay(500);
        const r = await cdp.send("Runtime.evaluate", { expression: EXPR, returnByValue: true, awaitPromise: true }, sid);
        const keys = r.result?.value;
        if (Array.isArray(keys) && keys.length > 300) {
            cdp.close();
            return keys;
        }
    }
    cdp.close();
    throw new Error(`${label} timeout`);
}

mkdirSync(CHROME_PROFILE, { recursive: true });
const chromeProc = spawn(chromeExecutable(), [
    `--remote-debugging-port=${CHROME_PORT}`,
    `--user-data-dir=${CHROME_PROFILE}`,
    "--no-first-run",
    CREEPJS,
], { stdio: "ignore" });
await waitCdp(`http://127.0.0.1:${CHROME_PORT}`, 45_000);
const chromeKeys = await keysFrom(`http://127.0.0.1:${CHROME_PORT}`, false, "chrome");
chromeProc.kill("SIGKILL");

const port = await freePort();
const veloraProc = spawn(VELORA_BIN, [
    "serve", "--host", "127.0.0.1", "--port", String(port),
    "--browser-profile", "chrome-local-huys-macbook-pro", "--log-level", "warn",
], { cwd: REPO, stdio: "ignore" });
await waitCdp(`http://127.0.0.1:${port}`);
const veloraKeys = await keysFrom(`http://127.0.0.1:${port}`, true, "velora");
veloraProc.kill("SIGKILL");

console.log(`chrome ${chromeKeys.length} velora ${veloraKeys.length}`);
let diff = 0;
for (let i = 0; i < Math.max(chromeKeys.length, veloraKeys.length); i += 1) {
    if (chromeKeys[i] !== veloraKeys[i]) {
        if (diff < 20) console.log(`idx ${i}: C=${chromeKeys[i]} V=${veloraKeys[i]}`);
        diff += 1;
    }
}
console.log(`diff positions: ${diff}`);