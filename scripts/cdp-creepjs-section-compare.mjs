#!/usr/bin/env node
/**
 * So sánh CreepJS theo từng phần (window.Fingerprint) — Velora vs Chrome.
 *
 *   node scripts/cdp-creepjs-section-compare.mjs
 *   node scripts/cdp-creepjs-section-compare.mjs --max-sec 20
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import WebSocket from "ws";
import { loadProfileDisplay } from "./lib/profile-screen.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const CREEPJS_URL = "https://abrahamjuliot.github.io/creepjs/";
const OUT_DIR = resolve(REPO, "code-check/tmp/creepjs-section-compare");
const CHROME_PORT = 9334;
const CHROME_PROFILE = resolve(os.tmpdir(), "creepjs-chrome-section");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = { profile: "chrome-local-huys-macbook-pro", maxSec: 20 };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--profile") out.profile = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
    }
    return out;
}

function chromeExecutable() {
    if (process.platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (process.platform === "win32") return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    return "google-chrome";
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

const EXTRACT_FP = `(() => {
    const header = document.querySelector(".fingerprint-header")?.innerText
        ?? document.getElementById("creep-fingerprint")?.innerText ?? "";
    const fpMatch = header.match(/FP ID:\\s*([0-9a-f]{8,})/i);
    const fp = window.Fingerprint;
    const creep = window.Creep;
    if (!fp) return { ready: false, reason: "no window.Fingerprint" };

    const pick = (obj, keys) => {
        if (!obj || typeof obj !== "object") return null;
        const out = {};
        for (const k of keys) if (k in obj) out[k] = obj[k];
        return Object.keys(out).length ? out : null;
    };

    const sections = {};
    for (const [name, data] of Object.entries(fp)) {
        if (!data || typeof data !== "object") {
            sections[name] = { present: false };
            continue;
        }
        const s = {
            present: true,
            lied: data.lied ?? null,
            hash: data.$hash ?? null,
        };
        switch (name) {
            case "navigator":
                Object.assign(s, pick(data, ["platform", "system", "device", "hardwareConcurrency", "deviceMemory", "vendor", "userAgentParsed"]));
                break;
            case "screen":
                Object.assign(s, pick(data, ["width", "height", "availWidth", "availHeight", "colorDepth", "pixelDepth", "touch"]));
                break;
            case "workerScope":
                Object.assign(s, pick(data, ["platform", "system", "language", "deviceMemory", "hardwareConcurrency", "webglRenderer", "webglVendor"]));
                break;
            case "offlineAudioContext":
                Object.assign(s, pick(data, ["sampleSum", "floatFrequencyDataSum", "compressorGainReduction", "totalUniqueSamples", "noise"]));
                break;
            case "canvas2d":
                Object.assign(s, pick(data, ["textMetricsSystemSum", "emojiSetLen", "liedTextMetrics"]));
                if (Array.isArray(data.emojiSet)) s.emojiSetLen = data.emojiSet.length;
                break;
            case "canvasWebgl":
                Object.assign(s, pick(data, ["gpu", "pixelsLen", "pixels2Len"]));
                if (Array.isArray(data.pixels)) s.pixelsLen = data.pixels.length;
                if (Array.isArray(data.pixels2)) s.pixels2Len = data.pixels2.length;
                break;
            case "maths":
                Object.assign(s, { dataLen: data.data ? Object.keys(data.data).length : 0 });
                break;
            case "timezone":
                Object.assign(s, pick(data, ["zone", "offset", "location", "locationMeasured"]));
                break;
            case "headless":
                Object.assign(s, pick(data, ["chromium", "likeHeadless", "headless", "stealth", "likeHeadlessRating", "headlessRating"]));
                break;
            case "features":
                Object.assign(s, pick(data, ["version", "versionRange", "cssVersion", "jsVersion", "windowVersion"]));
                break;
            case "windowFeatures":
                Object.assign(s, { keysLen: Array.isArray(data.keys) ? data.keys.length : 0 });
                break;
            case "fonts":
                Object.assign(s, { fontFaceLoadFontsLen: Array.isArray(data.fontFaceLoadFonts) ? data.fontFaceLoadFonts.length : 0 });
                break;
            case "media":
                Object.assign(s, { mimeTypesLen: Array.isArray(data.mimeTypes) ? data.mimeTypes.length : 0 });
                break;
            case "voices":
                Object.assign(s, pick(data, ["localLen", "remoteLen", "defaultVoiceName"]));
                if (Array.isArray(data.local)) s.localLen = data.local.length;
                if (Array.isArray(data.remote)) s.remoteLen = data.remote.length;
                break;
            case "lies":
                Object.assign(s, { totalLies: data.totalLies ?? null });
                break;
            case "clientRects":
                if (Array.isArray(data.emojiSet)) s.emojiSetLen = data.emojiSet.length;
                if (data.domrectSystemSum != null) s.domrectSystemSum = data.domrectSystemSum;
                break;
            default:
                break;
        }
        sections[name] = s;
    }

    return {
        ready: !!(fpMatch && fpMatch[1] && fpMatch[1].length >= 8),
        fpId: fpMatch ? fpMatch[1] : null,
        creepKeys: creep ? Object.keys(creep) : [],
        sections,
    };
})()`;

async function capture(label, endpoint, { navigate = true, maxSec = 20 }) {
    const t0 = Date.now();
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    const cdp = new Cdp(ws);
    let sid = null;

    if (navigate) {
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        ({ sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
        await cdp.send("Page.enable", {}, sid);
        await cdp.send("Runtime.enable", {}, sid);
        console.log(`[${label}] navigate ${CREEPJS_URL}`);
        await cdp.send("Page.navigate", { url: CREEPJS_URL }, sid);
    } else {
        const pages = await (await fetch(`${endpoint}/json/list`)).json();
        const tab = pages.find((p) => p.url?.includes("creepjs"));
        if (!tab?.webSocketDebuggerUrl) throw new Error("Chrome tab not found");
        cdp.close();
        const ws2 = new WebSocket(tab.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws2.once("open", res); ws2.once("error", rej); });
        const cdp2 = new Cdp(ws2);
        await cdp2.send("Page.enable");
        await cdp2.send("Runtime.enable");
        Object.assign(cdp, { ws: ws2, send: (...a) => cdp2.send(...a), close: () => ws2.close() });
    }

    let last = null;
    for (let i = 0; i < maxSec * 2 && Date.now() - t0 < maxSec * 1000; i += 1) {
        await delay(500);
        try {
            const r = await Promise.race([
                cdp.send("Runtime.evaluate", { expression: EXTRACT_FP, returnByValue: true }, sid),
                delay(8000).then(() => { throw new Error("evaluate timeout"); }),
            ]);
            last = r.result?.value ?? null;
        } catch (e) {
            last = { ...(last || {}), pollError: String(e.message || e) };
        }
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stdout.write(`\r[${label}] ${elapsed}s ready=${last?.ready ? "yes" : "no"} sections=${Object.keys(last?.sections || {}).length}`);
        if (last?.ready) break;
    }
    console.log("");
    cdp.close();
    return { label, browser: version.Browser, elapsedMs: Date.now() - t0, data: last };
}

function compareSections(chrome, velora) {
    const all = new Set([
        ...Object.keys(chrome?.sections || {}),
        ...Object.keys(velora?.sections || {}),
    ]);
    const rows = [];
    for (const name of [...all].sort()) {
        const c = chrome?.sections?.[name];
        const v = velora?.sections?.[name];
        let status = "ok";
        const notes = [];

        if (!c?.present && !v?.present) { status = "skip"; notes.push("cả hai absent"); }
        else if (!c?.present) { status = "velora-only"; notes.push("chỉ Velora có"); }
        else if (!v?.present) { status = "chrome-only"; notes.push("chỉ Chrome có"); }
        else if (c.hash && v.hash && c.hash === v.hash) { status = "match"; }
        else {
            status = "diff";
            if (c.hash !== v.hash) notes.push(`hash C=${(c.hash || "").slice(0, 12)} V=${(v.hash || "").slice(0, 12)}`);
            if (c.lied !== v.lied) notes.push(`lied C=${c.lied} V=${v.lied}`);
            for (const k of Object.keys({ ...c, ...v })) {
                if (["present", "hash", "lied"].includes(k)) continue;
                if (JSON.stringify(c[k]) !== JSON.stringify(v[k])) {
                    notes.push(`${k}: C=${JSON.stringify(c[k])} V=${JSON.stringify(v[k])}`);
                }
            }
        }
        rows.push({ section: name, status, chrome: c, velora: v, notes: notes.join("; ") });
    }
    return rows;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!existsSync(VELORA_BIN)) throw new Error("zig build first");
    await mkdir(OUT_DIR, { recursive: true });
    await mkdir(CHROME_PROFILE, { recursive: true });

    const display = loadProfileDisplay(REPO, args.profile);
    console.log(`=== CreepJS section compare (max ${args.maxSec}s) ===`);
    console.log(`profile screen: ${display.screen.width}×${display.screen.height} (built-in primary required)\n`);

    const chromeProc = spawn(chromeExecutable(), [
        `--remote-debugging-port=${CHROME_PORT}`,
        `--user-data-dir=${CHROME_PROFILE}`,
        "--no-first-run", "--no-default-browser-check", CREEPJS_URL,
    ], { stdio: "ignore" });
    await waitCdp(`http://127.0.0.1:${CHROME_PORT}`, 45_000);
    const chrome = await capture("chrome", `http://127.0.0.1:${CHROME_PORT}`, { navigate: false, maxSec: args.maxSec });

    const chromeScreen = chrome.data?.sections?.screen;
    if (chromeScreen?.width && chromeScreen.width !== display.screen.width) {
        console.error(`\n[HARDWARE] Chrome báo ${chromeScreen.width}×${chromeScreen.height}, profile cần ${display.screen.width}×${display.screen.height}.`);
        console.error("Đặt MacBook built-in làm primary display (System Settings → Displays), rồi chạy lại probe.\n");
        chromeProc.kill("SIGKILL");
        process.exit(2);
    }
    chromeProc.kill("SIGKILL");

    const port = await freePort();
    const veloraProc = spawn(VELORA_BIN, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", args.profile, "--log-level", "warn",
    ], { cwd: REPO, stdio: "ignore" });
    await waitCdp(`http://127.0.0.1:${port}`);
    const velora = await capture("velora", `http://127.0.0.1:${port}`, { navigate: true, maxSec: args.maxSec });
    veloraProc.kill("SIGKILL");

    const rows = compareSections(chrome.data, velora.data);
    const report = {
        at: new Date().toISOString(),
        url: CREEPJS_URL,
        chrome: { fpId: chrome.data?.fpId, elapsedMs: chrome.elapsedMs, sections: chrome.data?.sections },
        velora: { fpId: velora.data?.fpId, elapsedMs: velora.elapsedMs, sections: velora.data?.sections },
        compare: rows,
    };
    console.log("\n--- THEO TỪNG PHẦN ---");
    console.log(`Chrome FP: ${chrome.data?.fpId?.slice(0, 16)}... (${chrome.elapsedMs}ms)`);
    console.log(`Velora FP: ${velora.data?.fpId?.slice(0, 16)}... (${velora.elapsedMs}ms)\n`);

    const groups = { match: [], diff: [], other: [] };
    for (const r of rows) {
        if (r.status === "match") groups.match.push(r.section);
        else if (r.status === "diff") groups.diff.push(r);
        else groups.other.push(r);
    }

    console.log(`✔ Giống hash (${groups.match.length}): ${groups.match.join(", ") || "(none)"}`);
    console.log(`✘ Khác (${groups.diff.length}):`);
    for (const r of groups.diff) {
        console.log(`  - ${r.section}: ${r.notes || r.status}`);
    }
    if (groups.other.length) {
        console.log(`? Khác trạng thái (${groups.other.length}):`);
        for (const r of groups.other) console.log(`  - ${r.section}: ${r.status} — ${r.notes}`);
    }
    const gates = {
        veloraReady: velora.data?.ready === true,
        workerScopePresent: velora.data?.sections?.workerScope?.present === true,
        totalLies: velora.data?.sections?.lies?.totalLies ?? null,
        voicesLocalLen: velora.data?.sections?.voices?.localLen ?? null,
        audioUniqueSamples: velora.data?.sections?.offlineAudioContext?.totalUniqueSamples ?? null,
    };
    report.gates = gates;
    await writeFile(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));

    console.log("\n--- GATES ---");
    console.log(`workerScope: ${gates.workerScopePresent ? "OK" : "MISSING"}`);
    console.log(`lies: ${gates.totalLies} (want 0)`);
    console.log(`voices local: ${gates.voicesLocalLen}`);
    console.log(`audio unique samples: ${gates.audioUniqueSamples}`);
    console.log(`\nSaved: ${OUT_DIR}/report.json`);

    const gatesOk = gates.veloraReady &&
        gates.workerScopePresent &&
        gates.totalLies === 0;
    process.exitCode = gatesOk && chrome.data?.ready ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(2); });