#!/usr/bin/env node
/**
 * Debug online CreepJS hang — extract JS state via CDP.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const CREEPJS_URL = "https://abrahamjuliot.github.io/creepjs/";
const OUT_DIR = resolve(REPO, "code-check/tmp/creepjs-online-debug");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

const STATE_EXPR = `(() => {
    const body = document.body?.innerText ?? "";
    const fpLine = body.split("\\n").find((l) => l.startsWith("FP ID:")) ?? "";
    const creepFp = document.getElementById("creep-fingerprint");
    const fuzzy = document.getElementById("fuzzy-fingerprint");
    const timeEl = document.querySelector(".time");
    return {
        ready: document.readyState,
        title: document.title,
        bodyLen: body.length,
        fpLine: fpLine.slice(0, 120),
        fpInnerHtml: creepFp?.innerHTML?.slice(0, 200) ?? null,
        fuzzyText: fuzzy?.innerText?.slice(0, 80) ?? null,
        timeMs: timeEl?.textContent ?? null,
        hasFingerprint: typeof window.Fingerprint !== "undefined",
        hasCreep: typeof window.Creep !== "undefined",
        fingerprintKeys: window.Fingerprint ? Object.keys(window.Fingerprint).length : 0,
        creepKeys: window.Creep ? Object.keys(window.Creep).length : 0,
        hasHeadless: body.includes("Headless"),
        hasWebRTC: body.includes("WebRTC"),
        stunLine: body.split("\\n").find((l) => l.includes("stun")) ?? null,
        computing: /comput/i.test(fpLine),
        cryptoSubtle: !!(window.crypto && crypto.subtle && crypto.subtle.digest),
    };
})()`;

const HASH_BENCH = `(() => {
    const t0 = performance.now();
    const data = new TextEncoder().encode("bench-" + Date.now());
    return crypto.subtle.digest("SHA-256", data).then((buf) => {
        const arr = Array.from(new Uint8Array(buf));
        const hex = arr.map((b) => b.toString(16).padStart(2, "0")).join("");
        return { ok: true, ms: performance.now() - t0, hexLen: hex.length };
    }).catch((e) => ({ ok: false, err: String(e) }));
})()`;

async function main() {
    const maxSec = Number(process.argv[2] || 25);
    if (!existsSync(VELORA_BIN)) throw new Error("zig build first");
    await mkdir(OUT_DIR, { recursive: true });

    const port = await freePort();
    const logs = { stderr: [] };
    const proc = spawn(VELORA_BIN, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-local-huys-macbook-pro", "--log-level", "info",
    ], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", (b) => logs.stderr.push(b.toString()));

    for (let i = 0; i < 80; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
        await delay(100);
    }

    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    const cdp = new Cdp(ws);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sid);
    await cdp.send("Runtime.enable", {}, sid);

    console.log(`navigate: ${CREEPJS_URL}`);
    await cdp.send("Page.navigate", { url: CREEPJS_URL }, sid);

    const t0 = Date.now();
    const samples = [];
    while (Date.now() - t0 < maxSec * 1000) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        try {
            const r = await cdp.send("Runtime.evaluate", { expression: STATE_EXPR, returnByValue: true }, sid);
            const v = r.result?.value;
            samples.push({ elapsedSec: Number(elapsed), ...v });
            console.log(`[${elapsed}s] fp="${(v?.fpLine || "").slice(0, 40)}" time=${v?.timeMs} Fingerprint=${v?.hasFingerprint} Creep=${v?.hasCreep} subtle=${v?.cryptoSubtle}`);
            if (v?.hasFingerprint && v?.hasCreep && !v?.computing) break;
        } catch (e) {
            console.log(`[${elapsed}s] ERROR ${e.message}`);
        }
        await delay(1000);
    }

    let hashBench = null;
    try {
        const r = await cdp.send("Runtime.evaluate", { expression: HASH_BENCH, awaitPromise: true, returnByValue: true }, sid);
        hashBench = r.result?.value;
        console.log("hash bench:", hashBench);
    } catch (e) {
        hashBench = { ok: false, err: String(e) };
    }

    cdp.close();
    proc.kill("SIGKILL");

    const report = { at: new Date().toISOString(), maxSec, samples, hashBench, stderrTail: logs.stderr.join("").split("\n").slice(-40).join("\n") };
    await writeFile(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
    console.log(`saved: ${OUT_DIR}/report.json`);
}

main().catch((e) => { console.error(e); process.exit(2); });