#!/usr/bin/env node
/** Capture CreepJS clientRects from Chrome (max 20s). */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import os from "node:os";
import WebSocket from "ws";
import { DEFAULT_MAX_SEC } from "./lib/cdp-probe-budget.mjs";

const REPO = resolve(import.meta.dirname, "..");
const CREEPJS = "https://abrahamjuliot.github.io/creepjs/";
const OUT = resolve(REPO, "browser/profiles/assets/chrome-local-huys-macbook-pro-client-rects.json");
const PORT = 9343;
const PROFILE = resolve(os.tmpdir(), "client-rects-cap");
const MAX_SEC = DEFAULT_MAX_SEC;

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

const EMOJI_OBSERVER = `(() => {
    if (window.__creepEmojiHooked) return;
    window.__creepEmojiHooked = true;
    const store = () => {
        try {
            const top = window.top;
            if (!top.__creepEmojiDims) top.__creepEmojiDims = [];
            const els = document.getElementsByClassName("domrect-emoji");
            if (!els.length) return;
            const dims = [...els].map((el, i) => {
                const r = el.getClientRects()[0] || el.getBoundingClientRect();
                return { i, w: r.width, h: r.height };
            });
            if (dims.length > top.__creepEmojiDims.length) top.__creepEmojiDims = dims;
        } catch (e) {}
    };
    const orig = Element.prototype.getClientRects;
    Element.prototype.getClientRects = function (...args) {
        const out = orig.apply(this, args);
        if (this.classList?.contains("domrect-emoji")) store();
        return out;
    };
    new MutationObserver(store).observe(document.documentElement, { childList: true, subtree: true });
    store();
})();`;

const EXPR = `(() => {
    const cr = window.Fingerprint?.clientRects;
    if (!cr?.elementClientRects?.length) return null;
    return {
        elementClientRects: cr.elementClientRects,
        elementBoundingClientRect: cr.elementBoundingClientRect,
        rangeClientRects: cr.rangeClientRects,
        emojiSet: cr.emojiSet,
        domrectSystemSum: cr.domrectSystemSum,
    };
})()`;
const EVAL_OPTS = { expression: EXPR, returnByValue: true };

mkdirSync(PROFILE, { recursive: true });
const proc = spawn(chromeExecutable(), [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "about:blank",
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
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: EMOJI_OBSERVER });
await cdp.send("Page.navigate", { url: CREEPJS });

let data = null;
let pendingEmoji = [];
for (let i = 0; i < MAX_SEC * 20 && Date.now() - t0 < MAX_SEC * 1000; i += 1) {
    await delay(100);
    const r = await cdp.send("Runtime.evaluate", EVAL_OPTS);
    const v = r.result?.value;
    if (!v) continue;
    if (v.pending) {
        if (v.emojiDims?.length) pendingEmoji = v.emojiDims;
        continue;
    }
    const hooked = await cdp.send("Runtime.evaluate", {
        expression: "globalThis.__creepEmojiDims || []",
        returnByValue: true,
    });
    if (hooked.result?.value?.length) v.emojiDims = hooked.result.value;
    else if (!v.emojiDims?.length && pendingEmoji.length) v.emojiDims = pendingEmoji;
    data = v;
    break;
}
cdp.close();
proc.kill("SIGKILL");

if (!data) {
    console.error("[HANG] client rects capture exceeded 20s");
    process.exit(3);
}
writeFileSync(OUT, JSON.stringify(data, null, 2));
console.log(`saved ${OUT} emojiDims=${data.emojiDims?.length ?? 0} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);