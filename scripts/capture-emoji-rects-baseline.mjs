#!/usr/bin/env node
/** Capture domrect-emoji w/h from Chrome via local probe (max 20s). */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import WebSocket from "ws";
import { DEFAULT_MAX_SEC } from "./lib/cdp-probe-budget.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROBE_HTML = readFileSync(resolve(REPO, "code-check/sites/creep/emoji-rects-probe.html"));
const CLIENT_RECTS = resolve(REPO, "browser/profiles/assets/chrome-local-huys-macbook-pro-client-rects.json");
const PORT = 9349;
const PROFILE = resolve(os.tmpdir(), "emoji-rects-cap");
const MAX_SEC = DEFAULT_MAX_SEC;

const httpServer = createServer((_, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PROBE_HTML);
});
const HTTP_PORT = await new Promise((res) => httpServer.listen(0, "127.0.0.1", () => res(httpServer.address().port)));
const PAGE_URL = `http://127.0.0.1:${HTTP_PORT}/`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const chromeExecutable = () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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
    send(method, params = {}) {
        const id = this.id++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    close() { this.ws.close(); }
}

const EXPR = `(() => {
    if (!window.__emojiDimsReady) return null;
    return [...document.getElementsByClassName('domrect-emoji')].map((el, i) => {
        const r = el.getClientRects()[0] || el.getBoundingClientRect();
        return { i, w: r.width, h: r.height };
    });
})()`;

const proc = spawn(chromeExecutable(), [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    PAGE_URL,
], { stdio: "ignore" });

const t0 = Date.now();
while (Date.now() - t0 < 15_000) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {}
    await delay(100);
}

const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = pages[0];
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
const cdp = new Cdp(ws);
await cdp.send("Runtime.enable");

let dims = null;
while (Date.now() - t0 < MAX_SEC * 1000) {
    await delay(200);
    const r = await cdp.send("Runtime.evaluate", { expression: EXPR, returnByValue: true });
    if (r.result?.value?.length) { dims = r.result.value; break; }
}
cdp.close();
proc.kill("SIGKILL");
httpServer.close();

if (!dims?.length) {
    console.error("[HANG] emoji rects capture exceeded 20s");
    process.exit(3);
}

const existing = JSON.parse(readFileSync(CLIENT_RECTS, "utf8"));
existing.emojiDims = dims;
writeFileSync(CLIENT_RECTS, JSON.stringify(existing, null, 2));
console.log(`updated ${CLIENT_RECTS} emojiDims=${dims.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);