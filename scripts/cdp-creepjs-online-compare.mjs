#!/usr/bin/env node
/**
 * So sánh CreepJS online: Velora vs Chrome thật (tuần tự, mỗi bên tối đa 20s).
 *
 *   node scripts/cdp-creepjs-online-compare.mjs
 *   node scripts/cdp-creepjs-online-compare.mjs --max-sec 20
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const CREEPJS_URL = "https://abrahamjuliot.github.io/creepjs/";
const OUT_DIR = resolve(REPO, "code-check/tmp/creepjs-online-compare");
const CHROME_PORT = 9334;
const CHROME_PROFILE = resolve(os.tmpdir(), "creepjs-chrome-online");

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
        try {
            if ((await fetch(`${endpoint}/json/version`)).ok) return;
        } catch {}
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

const EXTRACT = `(() => {
    const body = document.body?.innerText ?? "";
    const header = document.querySelector(".fingerprint-header")?.innerText
        ?? document.querySelector(".fingerprint-header .ellipsis-all")?.innerText
        ?? document.getElementById("creep-fingerprint")?.innerText
        ?? "";
    const line = (p) => body.split("\\n").find((l) => l.startsWith(p)) ?? "";
    const pct = (label) => {
        const i = body.indexOf(label);
        if (i < 0) return null;
        const m = body.slice(i, i + 200).match(/(\\d+(?:\\.\\d+)?)%/);
        return m ? Number(m[1]) : null;
    };
    const passed = [...body.matchAll(/✔[^\\n]{0,80}?([\\w][\\w ]{0,40}) passed/gi)].map((m) => m[1].trim());
    const failed = [...body.matchAll(/✘[^\\n]{0,80}?([\\w][\\w ]{0,40}) failed/gi)].map((m) => m[1].trim());
    const fpMatch = header.match(/FP ID:\\s*([0-9a-f]{8,})/i)
        ?? body.match(/FP ID:\\s*([0-9a-f]{8,})/i);
    const fpId = fpMatch ? fpMatch[1] : line("FP ID:").replace(/^FP ID:\\s*/i, "").trim();
    const fuzzyMatch = header.match(/Fuzzy:\\s*([0-9a-f]{8,})/i)
        ?? body.match(/Fuzzy:\\s*([0-9a-f]{8,})/i);
    return {
        fpId,
        fuzzy: fuzzyMatch ? fuzzyMatch[1] : line("Fuzzy:").replace(/^Fuzzy:\\s*/i, "").trim(),
        ready: fpId.length >= 8 && !/comput/i.test(fpId),
        headless: { like: pct("like headless:"), headless: pct("headless:"), chromium: pct("chromium:") },
        passed,
        failed,
        bodyLen: body.length,
        hasAudio: body.includes("Audio") && body.includes("sum:"),
        hasWorker: /worker/i.test(body) && body.includes("DedicatedWorker"),
    };
})()`;

async function capture(label, endpoint, { navigate = true, maxSec = 20, attachUrl = CREEPJS_URL }) {
    const t0 = Date.now();
    const logs = { stderr: [] };
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    const cdp = new Cdp(ws);
    let sid = null;

    if (navigate) {
        await cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
        const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
        ({ sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true }));
        await cdp.send("Page.enable", {}, sid);
        await cdp.send("Runtime.enable", {}, sid);
        console.log(`[${label}] navigate ${CREEPJS_URL}`);
        await cdp.send("Page.navigate", { url: CREEPJS_URL }, sid);
    } else {
        const pages = await (await fetch(`${endpoint}/json/list`)).json();
        const tab = pages.find((p) => p.url?.includes("creepjs") || p.url?.includes(attachUrl));
        if (!tab?.webSocketDebuggerUrl) throw new Error("Chrome tab creepjs not found");
        cdp.close();
        const ws2 = new WebSocket(tab.webSocketDebuggerUrl);
        await new Promise((res, rej) => { ws2.once("open", res); ws2.once("error", rej); });
        const cdp2 = new Cdp(ws2);
        await cdp2.send("Page.enable");
        await cdp2.send("Runtime.enable");
        Object.assign(cdp, { ws: ws2, send: (...a) => cdp2.send(...a), close: () => ws2.close() });
    }

    let last = null;
    const polls = maxSec * 2;
    for (let i = 0; i < polls && Date.now() - t0 < maxSec * 1000; i += 1) {
        await delay(500);
        try {
            const r = await Promise.race([
                cdp.send("Runtime.evaluate", { expression: EXTRACT, returnByValue: true }, sid),
                delay(4000).then(() => { throw new Error("evaluate timeout"); }),
            ]);
            last = r.result?.value ?? null;
        } catch (e) {
            last = { ...(last || {}), pollError: String(e.message || e) };
        }
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stdout.write(`\r[${label}] ${elapsed}s fp=${(last?.fpId || "").slice(0, 16)} pass=${last?.passed?.length ?? 0} fail=${last?.failed?.length ?? 0}`);
        if (last?.ready) break;
    }
    console.log("");
    cdp.close();
    return {
        label,
        browser: version.Browser,
        elapsedMs: Date.now() - t0,
        creep: last,
        logs,
    };
}

function diffList(a = [], b = []) {
    const sa = new Set(a);
    const sb = new Set(b);
    return {
        onlyA: [...sa].filter((x) => !sb.has(x)),
        onlyB: [...sb].filter((x) => !sa.has(x)),
        both: [...sa].filter((x) => sb.has(x)),
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!existsSync(VELORA_BIN)) throw new Error("zig build first");

    await mkdir(OUT_DIR, { recursive: true });
    await mkdir(CHROME_PROFILE, { recursive: true });

    console.log(`=== CreepJS online compare (max ${args.maxSec}s mỗi bên) ===`);
    console.log(`URL: ${CREEPJS_URL}\n`);

    // 1) Chrome thật
    const chromeProc = spawn(chromeExecutable(), [
        `--remote-debugging-port=${CHROME_PORT}`,
        `--user-data-dir=${CHROME_PROFILE}`,
        "--no-first-run",
        "--no-default-browser-check",
        CREEPJS_URL,
    ], { stdio: "ignore" });
    await waitCdp(`http://127.0.0.1:${CHROME_PORT}`, 45_000);
    const chrome = await capture("chrome", `http://127.0.0.1:${CHROME_PORT}`, { navigate: false, maxSec: args.maxSec });
    chromeProc.kill("SIGKILL");

    // 2) Velora
    const port = await freePort();
    const veloraProc = spawn(VELORA_BIN, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", args.profile, "--log-level", "info",
    ], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    const veloraLogs = { stderr: [], stdout: [] };
    veloraProc.stderr.on("data", (b) => veloraLogs.stderr.push(b.toString()));
    veloraProc.stdout.on("data", (b) => veloraLogs.stdout.push(b.toString()));
    await waitCdp(`http://127.0.0.1:${port}`);
    const velora = await capture("velora", `http://127.0.0.1:${port}`, { navigate: true, maxSec: args.maxSec });
    velora.logs = veloraLogs;
    veloraProc.kill("SIGKILL");

    const testDiff = diffList(velora.creep?.passed, chrome.creep?.passed);
    const failDiff = diffList(velora.creep?.failed, chrome.creep?.failed);

    const report = {
        at: new Date().toISOString(),
        url: CREEPJS_URL,
        maxSec: args.maxSec,
        chrome,
        velora,
        diff: { tests: testDiff, failures: failDiff },
    };

    await writeFile(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
    await writeFile(resolve(OUT_DIR, "velora-stderr.log"), veloraLogs.stderr.join(""));

    console.log("\n--- KẾT QUẢ ---");
    console.log(`Chrome FP:  ${chrome.creep?.fpId || "(chưa xong)"}  (${chrome.elapsedMs}ms)`);
    console.log(`Velora FP:  ${velora.creep?.fpId || "(chưa xong)"}  (${velora.elapsedMs}ms)`);
    console.log(`Chrome headless: like=${chrome.creep?.headless?.like ?? "?"}% headless=${chrome.creep?.headless?.headless ?? "?"}%`);
    console.log(`Velora headless: like=${velora.creep?.headless?.like ?? "?"}% headless=${velora.creep?.headless?.headless ?? "?"}%`);
    console.log(`Chrome passed: ${chrome.creep?.passed?.length ?? 0} | failed: ${chrome.creep?.failed?.length ?? 0}`);
    console.log(`Velora passed: ${velora.creep?.passed?.length ?? 0} | failed: ${velora.creep?.failed?.length ?? 0}`);
    if (testDiff.onlyA.length) console.log(`Chỉ Velora pass: ${testDiff.onlyA.join(", ")}`);
    if (testDiff.onlyB.length) console.log(`Chỉ Chrome pass: ${testDiff.onlyB.join(", ")}`);
    if (failDiff.onlyA.length || failDiff.onlyB.length) {
        console.log(`Velora fail khác: ${failDiff.onlyA.join(", ") || "(none)"}`);
        console.log(`Chrome fail khác: ${failDiff.onlyB.join(", ") || "(none)"}`);
    }
    if (velora.creep?.pollError) console.log(`Velora poll error: ${velora.creep.pollError}`);
    console.log(`\nSaved: ${OUT_DIR}/report.json`);

    const veloraOk = velora.creep?.ready === true;
    const chromeOk = chrome.creep?.ready === true;
    process.exitCode = veloraOk && chromeOk ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(2); });