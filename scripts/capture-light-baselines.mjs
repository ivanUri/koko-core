#!/usr/bin/env node
/** Capture voices + clientRects emoji dims from Chrome CreepJS via CDP (max 20s). */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import os from "node:os";
import WebSocket from "ws";
import { DEFAULT_MAX_SEC } from "./lib/cdp-probe-budget.mjs";

const REPO = resolve(import.meta.dirname, "..");
const PROFILE = "chrome-local-huys-macbook-pro";
const CREEPJS = "https://abrahamjuliot.github.io/creepjs/";
const PORT = 9344;
const CHROME_PROFILE = resolve(os.tmpdir(), "creep-light-cap");
const MAX_SEC = DEFAULT_MAX_SEC;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const chromeExecutable = () => "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const OBSERVER = `(()=>{if(window.__creepEmojiObserver)return;window.__creepEmojiDims=[];const snap=()=>{const els=document.getElementsByClassName("domrect-emoji");if(!els.length)return;window.__creepEmojiDims=[...els].map((el,i)=>{const r=el.getClientRects()[0]||el.getBoundingClientRect();return{i,w:r.width,h:r.height}})};const obs=new MutationObserver(snap);obs.observe(document.documentElement,{childList:true,subtree:true});window.__creepEmojiObserver=obs;snap()})();`;

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

const EXPR = `(() => {
    const cr = window.Fingerprint?.clientRects;
    if (!cr?.elementClientRects?.length) return null;
    const voices = speechSynthesis.getVoices();
    return {
        elementClientRects: cr.elementClientRects,
        emojiSet: cr.emojiSet,
        domrectSystemSum: cr.domrectSystemSum,
        emojiDims: window.__creepEmojiDims || [],
        voices: voices.map((v) => ({
            name: v.name, lang: v.lang, localService: v.localService,
            default: v.default, voiceURI: v.voiceURI,
        })),
    };
})()`;

mkdirSync(CHROME_PROFILE, { recursive: true });
const proc = spawn(chromeExecutable(), [
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${CHROME_PROFILE}`,
    "--no-first-run", CREEPJS,
], { stdio: "ignore" });

const t0 = Date.now();
while (Date.now() - t0 < 15000) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {}
    await delay(100);
}

const pages = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const tab = pages.find((p) => p.url?.includes("creepjs")) ?? pages[0];
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
const cdp = new Cdp(ws);
await cdp.send("Runtime.enable");
await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: OBSERVER });
await cdp.send("Page.reload", { ignoreCache: true });

let data = null;
while (Date.now() - t0 < MAX_SEC * 1000) {
    await delay(200);
    const r = await cdp.send("Runtime.evaluate", { expression: EXPR, returnByValue: true });
    if (r.result?.value) { data = r.result.value; break; }
}
cdp.close();
proc.kill("SIGKILL");

if (!data) {
    console.error("[HANG] capture-light-baselines exceeded 20s");
    process.exit(3);
}

const assets = join(REPO, "browser/profiles/assets");
const rectsPath = join(assets, `${PROFILE}-client-rects.json`);
const existing = existsSync(rectsPath) ? JSON.parse(readFileSync(rectsPath, "utf8")) : {};
writeFileSync(rectsPath, JSON.stringify({ ...existing, ...data }, null, 2));
writeFileSync(join(assets, `${PROFILE}-voices.json`), JSON.stringify(data.voices, null, 2));

console.log(`voices=${data.voices.length} remote=${data.voices.filter((v) => !v.localService).length} emojiDims=${data.emojiDims.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);