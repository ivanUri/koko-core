#!/usr/bin/env node
/**
 * Compare CreepJS offlineAudioContext fields — Chrome vs Velora.
 *   node scripts/cdp-audio-field-compare.mjs --max-sec 20
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const CREEPJS_URL = "https://abrahamjuliot.github.io/creepjs/";
const OUT_DIR = resolve(REPO, "code-check/tmp/audio-field-compare");
const CHROME_PORT = 9336;
const CHROME_PROFILE = resolve(os.tmpdir(), "creepjs-audio-field");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const EXTRACT = `(() => {
  const a = window.Fingerprint?.offlineAudioContext;
  if (!a) return { ready: false };
  return {
    ready: true,
    hash: a.$hash,
    totalUniqueSamples: a.totalUniqueSamples,
    compressorGainReduction: a.compressorGainReduction,
    floatFrequencyDataSum: a.floatFrequencyDataSum,
    floatTimeDomainDataSum: a.floatTimeDomainDataSum,
    sampleSum: a.sampleSum,
    noise: a.noise,
    lied: a.lied,
    binsSample: a.binsSample,
    copySample: a.copySample,
    values: a.values,
  };
})()`;

function chromeExecutable() {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
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

async function waitCdp(endpoint, ms = 30_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) return; } catch {}
        await delay(100);
    }
    throw new Error(`CDP not ready: ${endpoint}`);
}

async function capture(label, endpoint, { navigate = true, maxSec = 20 }) {
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    const cdp = new Cdp(ws);
    let sid = null;

    if (navigate) {
        const { targetId } = await cdp.send("Target.createTarget", { url: CREEPJS_URL });
        ({ sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
        await cdp.send("Runtime.enable", {}, sid);
    } else {
        const pages = await (await fetch(`${endpoint}/json/list`)).json();
        const tab = pages.find((p) => p.url?.includes("creepjs"));
        if (!tab?.webSocketDebuggerUrl) throw new Error("Chrome creepjs tab not found");
        cdp.close();
        const ws2 = new WebSocket(tab.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws2.once("open", res); ws2.once("error", rej); });
        const cdp2 = new Cdp(ws2);
        await cdp2.send("Runtime.enable");
        Object.assign(cdp, { ws: ws2, send: (...a) => cdp2.send(...a), close: () => ws2.close() });
    }

    let last = null;
    for (let i = 0; i < maxSec * 2; i += 1) {
        await delay(500);
        const r = await cdp.send("Runtime.evaluate", { expression: EXTRACT, returnByValue: true }, sid);
        last = r.result?.value ?? null;
        if (last?.ready) break;
    }
    cdp.close();
    return last;
}

function diffFields(chrome, velora) {
    const fields = [
        "hash", "totalUniqueSamples", "compressorGainReduction",
        "floatFrequencyDataSum", "floatTimeDomainDataSum", "sampleSum", "noise", "lied",
    ];
    const diffs = [];
    for (const f of fields) {
        if (JSON.stringify(chrome[f]) !== JSON.stringify(velora[f])) {
            diffs.push({ field: f, chrome: chrome[f], velora: velora[f] });
        }
    }
    if (JSON.stringify(chrome.binsSample) !== JSON.stringify(velora.binsSample)) {
        diffs.push({ field: "binsSample", chrome: chrome.binsSample?.slice?.(0, 8), velora: velora.binsSample?.slice?.(0, 8) });
    }
    if (JSON.stringify(chrome.copySample) !== JSON.stringify(velora.copySample)) {
        diffs.push({ field: "copySample", chrome: chrome.copySample?.slice?.(0, 8), velora: velora.copySample?.slice?.(0, 8) });
    }
    const keys = new Set([...Object.keys(chrome.values || {}), ...Object.keys(velora.values || {})]);
    for (const k of [...keys].sort()) {
        if (JSON.stringify(chrome.values?.[k]) !== JSON.stringify(velora.values?.[k])) {
            diffs.push({ field: `values.${k}`, chrome: chrome.values?.[k], velora: velora.values?.[k] });
        }
    }
    return diffs;
}

async function main() {
    const maxSec = Number(process.argv.find((_, i, a) => a[i - 1] === "--max-sec") || 20);
    await mkdir(OUT_DIR, { recursive: true });

    const chromeProc = spawn(chromeExecutable(), [
        `--remote-debugging-port=${CHROME_PORT}`,
        `--user-data-dir=${CHROME_PROFILE}`,
        "--no-first-run", "--no-default-browser-check", CREEPJS_URL,
    ], { stdio: "ignore" });
    await waitCdp(`http://127.0.0.1:${CHROME_PORT}`, 45_000);
    const chrome = await capture("chrome", `http://127.0.0.1:${CHROME_PORT}`, { navigate: false, maxSec });
    chromeProc.kill("SIGKILL");

    const port = await freePort();
    const veloraProc = spawn(VELORA_BIN, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-local-huys-macbook-pro", "--log-level", "warn",
    ], { cwd: REPO, stdio: "ignore" });
    await waitCdp(`http://127.0.0.1:${port}`);
    const velora = await capture("velora", `http://127.0.0.1:${port}`, { navigate: true, maxSec });
    veloraProc.kill("SIGKILL");

    const diffs = diffFields(chrome, velora);
    const report = { chrome, velora, diffs };
    await writeFile(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));

    console.log("Chrome hash:", chrome?.hash?.slice(0, 16));
    console.log("Velora hash:", velora?.hash?.slice(0, 16));
    console.log(`Diffs (${diffs.length}):`);
    for (const d of diffs) {
        console.log(`  ${d.field}: C=${JSON.stringify(d.chrome)} V=${JSON.stringify(d.velora)}`);
    }
    console.log("Saved:", resolve(OUT_DIR, "report.json"));
}

main().catch((e) => { console.error(e); process.exit(1); });