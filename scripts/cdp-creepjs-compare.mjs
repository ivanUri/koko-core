#!/usr/bin/env node
/**
 * Compare CreepJS fingerprint: Velora vs Chrome thật (spawn + CDP).
 *
 * Usage:
 *   node scripts/cdp-creepjs-compare.mjs
 *   node scripts/cdp-creepjs-compare.mjs --profile chrome-local-huys-macbook-pro
 */

import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const CREEPJS_ONLINE = "https://abrahamjuliot.github.io/creepjs/";
const LOCAL_STATIC_PORT = 8765;
const OUT_DIR = resolve(REPO, "code-check/tmp/creepjs-compare");
const CHROME_CDP_PORT = 9334;
const CHROME_PROFILE = resolve(os.tmpdir(), "creepjs-chrome-real-profile");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = {
        profile: "chrome-local-huys-macbook-pro",
        waitSec: 15,
        maxSec: 15,
        local: false,
        url: CREEPJS_ONLINE,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--profile") out.profile = argv[++i];
        else if (a === "--wait-sec" || a === "--max-sec") out.waitSec = out.maxSec = Number(argv[++i]);
        else if (a === "--local") {
            out.local = true;
            out.url = `http://127.0.0.1:${LOCAL_STATIC_PORT}/index.html`;
        } else if (a === "--url") out.url = argv[++i];
    }
    return out;
}

function chromeExecutable() {
    if (process.platform === "darwin") {
        return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    }
    if (process.platform === "win32") {
        return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    }
    return "google-chrome";
}

async function getFreePort() {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.unref();
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

class CdpClient {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
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

    send(method, params = {}, sessionId = null) {
        const id = this.nextId++;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(payload));
        });
    }

    close() {
        this.ws.close();
    }
}

async function connectCdp(endpoint) {
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.once("open", res);
        ws.once("error", rej);
    });
    const client = new CdpClient(ws);
    await client.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);
    return { client, sessionId, targetId, browser: version.Browser };
}

async function evaluate(client, sessionId, expression) {
    const result = await client.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
    }, sessionId);
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result?.value;
}

async function spawnVelora(profile, port) {
    const proc = spawn(VELORA_BIN, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", profile, "--log-level", "info",
    ], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    proc.veloraLogs = { stdout: [], stderr: [] };
    proc.stdout?.on("data", (b) => proc.veloraLogs.stdout.push(b.toString()));
    proc.stderr?.on("data", (b) => proc.veloraLogs.stderr.push(b.toString()));
    const endpoint = `http://127.0.0.1:${port}`;
    await waitCdp(endpoint);
    return { proc, endpoint };
}

async function spawnRealChrome(startUrl) {
    await mkdir(CHROME_PROFILE, { recursive: true });
    const proc = spawn(chromeExecutable(), [
        `--remote-debugging-port=${CHROME_CDP_PORT}`,
        `--user-data-dir=${CHROME_PROFILE}`,
        "--no-first-run",
        "--no-default-browser-check",
        startUrl,
    ], { stdio: "ignore" });
    const endpoint = `http://127.0.0.1:${CHROME_CDP_PORT}`;
    await waitCdp(endpoint, 45_000);
    return { proc, endpoint };
}

const EXTRACT_CREEPJS = `(() => {
    const body = document.body?.innerText ?? "";
    const line = (prefix) => body.split("\\n").find((l) => l.startsWith(prefix)) ?? "";
    const after = (label) => {
        const i = body.indexOf(label);
        if (i < 0) return null;
        return body.slice(i, i + 500).replace(/\\s+/g, " ").trim();
    };
    const pct = (label) => {
        const block = after(label);
        if (!block) return null;
        const m = block.match(/(\\d+(?:\\.\\d+)?)%/);
        return m ? Number(m[1]) : null;
    };
    const fpEl = document.getElementById("creep-fingerprint")?.textContent ?? "";
    const fpFromEl = fpEl.replace(/^FP ID:\\s*/i, "").trim();
    const fpId = (line("FP ID:").replace(/^FP ID:\\s*/, "") || fpFromEl).trim();
    const screenMatch = body.match(/screen:\\s*(\\d+)\\s*x\\s*(\\d+)/i);
    const audioPassed = body.includes("audio passed");
    const speechPassed = body.includes("speech passed");
    return {
        fpId,
        fuzzy: line("Fuzzy:").replace(/^Fuzzy:\\s*/, ""),
        ready: fpId.length > 0 && !/computing/i.test(fpId),
        audioPassed,
        speechPassed,
        headless: {
            chromium: pct("chromium:"),
            likeHeadless: pct("like headless:"),
            headless: pct("headless:"),
            stealth: pct("stealth:"),
            block: after("Headless"),
        },
        resistance: after("Resistance"),
        navigator: after("Navigator"),
        webgl: after("WebGL"),
        screen: after("Screen"),
        screenSize: screenMatch ? { w: Number(screenMatch[1]), h: Number(screenMatch[2]) } : null,
        canvas: after("Canvas 2d"),
        fonts: after("Fonts"),
        audio: after("Audio"),
        worker: after("Worker"),
        intl: after("Intl"),
        timezone: after("Timezone"),
        bodyLen: body.length,
        bodyPreview: body.slice(0, 12000),
    };
})()`;

const EXTRACT_NAV = `(() => ({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    languages: [...navigator.languages],
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    webdriver: navigator.webdriver,
    vendor: navigator.vendor,
    brands: navigator.userAgentData?.brands || [],
    uaPlatform: navigator.userAgentData?.platform || null,
    webgl: (() => {
        const c = document.createElement("canvas");
        const gl = c.getContext("webgl");
        if (!gl) return null;
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        return {
            vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
            renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
        };
    })(),
}))()`;

async function captureCreepJs(label, endpoint, waitSec, creepUrl, navigate = true) {
    const t0 = Date.now();
    let client = null;
    try {
        const conn = await connectCdp(endpoint);
        client = conn.client;

        if (navigate) {
            console.log(`[${label}] navigate ${creepUrl}`);
            await client.send("Page.navigate", { url: creepUrl }, conn.sessionId);
        } else {
            console.log(`[${label}] attach existing CreepJS tab`);
            const pages = await (await fetch(`${endpoint}/json/list`)).json();
            const creepTab = pages.find((p) => p.url?.includes("creepjs") || p.url?.includes("127.0.0.1:8765"));
            if (creepTab?.webSocketDebuggerUrl) {
                client.close();
                const ws = new WebSocket(creepTab.webSocketDebuggerUrl);
                await new Promise((res, rej) => {
                    ws.once("open", res);
                    ws.once("error", rej);
                });
                const tabClient = new CdpClient(ws);
                await tabClient.send("Page.enable");
                await tabClient.send("Runtime.enable");
                conn.sessionId = null;
                conn.client = tabClient;
                client = tabClient;
            }
        }

        let creep = null;
        let stable = 0;
        let lastFp = "";
        const polls = waitSec * 2;
        for (let i = 0; i < polls; i += 1) {
            await delay(500);
            creep = await evaluate(conn.client, conn.sessionId, EXTRACT_CREEPJS);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            process.stdout.write(`\r[${label}] ${elapsed}s fp=${(creep?.fpId || "").slice(0, 12)} headless=${creep?.headless?.likeHeadless ?? "?"}`);
            const headlessReady = creep?.headless?.likeHeadless != null;
            const milestones = creep?.audioPassed && creep?.speechPassed;
            const fpReady = creep?.ready && creep.fpId.length >= 8;
            const onlineReady = fpReady && creep.bodyLen > 2500 && headlessReady;
            const localReady = milestones && fpReady;
            if (localReady || onlineReady || (milestones && i >= polls - 2)) {
                if (creep.fpId === lastFp) stable += 1;
                else stable = 0;
                lastFp = creep.fpId;
                if (stable >= 2 || localReady || onlineReady) break;
            }
        }
        console.log("");

        const navigator = await evaluate(conn.client, conn.sessionId, EXTRACT_NAV);
        return {
            label,
            browser: conn.browser,
            elapsedMs: Date.now() - t0,
            creepjs: creep,
            navigator,
        };
    } finally {
        client?.close();
    }
}

function sessionSummary(data) {
    const c = data.creepjs || {};
    const h = c.headless || {};
    return {
        fpId: c.fpId,
        fuzzy: c.fuzzy,
        headless: h,
        audioPassed: c.audioPassed,
        speechPassed: c.speechPassed,
        screenSize: c.screenSize,
        webdriver: data.navigator?.webdriver,
        languages: data.navigator?.languages,
        userAgent: data.navigator?.userAgent,
        webgl: data.navigator?.webgl,
        elapsedMs: data.elapsedMs,
    };
}

function diffObjects(a, b, labelA, labelB) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const diffs = [];
    for (const k of keys) {
        const va = JSON.stringify(a[k]);
        const vb = JSON.stringify(b[k]);
        if (va !== vb) diffs.push({ field: k, [labelA]: a[k], [labelB]: b[k] });
    }
    return diffs;
}

function buildMarkdown(comparison) {
    const lines = [
        "# CreepJS — Velora vs Chrome thật",
        "",
        `Generated: ${comparison.generatedAt}`,
        `Profile: ${comparison.profile}`,
        "",
    ];
    for (const [key, sess] of Object.entries(comparison.sessions)) {
        const s = sess.summary;
        lines.push(`## ${key}`);
        lines.push(`- FP ID: ${s.fpId || "n/a"}`);
        lines.push(`- Fuzzy: ${s.fuzzy || "n/a"}`);
        lines.push(`- Headless: like=${s.headless?.likeHeadless ?? "?"}% headless=${s.headless?.headless ?? "?"}% stealth=${s.headless?.stealth ?? "?"}%`);
        lines.push(`- Screen: ${s.screenSize ? `${s.screenSize.w}x${s.screenSize.h}` : "n/a"}`);
        lines.push(`- webdriver: ${String(s.webdriver)}`);
        lines.push(`- languages: ${JSON.stringify(s.languages)}`);
        lines.push(`- webgl: ${JSON.stringify(s.webgl)}`);
        lines.push("");
    }
    lines.push("## Khác biệt Velora vs Chrome thật");
    for (const d of comparison.diffs.velora_vs_chrome) {
        const keys = Object.keys(d).filter((k) => k !== "field");
        lines.push(`- **${d.field}**: ${keys.map((k) => `${k}=${JSON.stringify(d[k])}`).join(" | ")}`);
    }
    return lines.join("\n");
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!existsSync(VELORA_BIN)) {
        throw new Error("zig build first — zig-out/bin/velora missing");
    }

    await mkdir(OUT_DIR, { recursive: true });

    let chromeProc = null;
    let veloraProc = null;
    let staticProc = null;
    const hardKill = setTimeout(() => {
        console.error(`\n[HARD LIMIT ${args.maxSec}s] killing all browsers`);
        if (veloraProc && !veloraProc.killed) veloraProc.kill("SIGKILL");
        if (chromeProc && !chromeProc.killed) chromeProc.kill("SIGKILL");
        if (staticProc && !staticProc.killed) staticProc.kill("SIGKILL");
    }, args.maxSec * 1000);

    try {
        if (args.local) {
            staticProc = spawn(process.execPath, [
                resolve(REPO, "scripts/serve-creep-local.mjs"),
                "--port", String(LOCAL_STATIC_PORT),
            ], { cwd: REPO, stdio: "ignore" });
            await delay(400);
        }
        console.log(`Khởi động Chrome thật + Velora (${args.url})...`);
        const veloraPort = await getFreePort();
        const [chromeLaunch, veloraLaunch] = await Promise.all([
            spawnRealChrome(args.url),
            spawnVelora(args.profile, veloraPort),
        ]);
        chromeProc = chromeLaunch.proc;
        veloraProc = veloraLaunch.proc;

        console.log(`Capture CreepJS (tối đa ~${args.waitSec}s mỗi bên, thoát sớm khi ổn định)...`);
        const [chrome, velora] = await Promise.all([
            captureCreepJs("chrome-real", `http://127.0.0.1:${CHROME_CDP_PORT}`, args.waitSec, args.url, false),
            captureCreepJs("velora", `http://127.0.0.1:${veloraPort}`, args.waitSec, args.url, true),
        ]);

        const chromeSummary = sessionSummary(chrome);
        const veloraSummary = sessionSummary(velora);

        const comparison = {
            generatedAt: new Date().toISOString(),
            creepjsUrl: args.url,
            profile: args.profile,
            sessions: {
                "chrome-real": { description: "Chrome thật (spawn + CDP)", raw: chrome, summary: chromeSummary },
                velora: { description: `Velora serve --browser-profile ${args.profile}`, raw: velora, summary: veloraSummary },
            },
            diffs: {
                velora_vs_chrome: diffObjects(veloraSummary, chromeSummary, "velora", "chrome_real"),
            },
        };

        await writeFile(resolve(OUT_DIR, "comparison.json"), JSON.stringify(comparison, null, 2));
        await writeFile(resolve(OUT_DIR, "comparison.md"), buildMarkdown(comparison));
        await writeFile(resolve(OUT_DIR, "chrome-real.json"), JSON.stringify(chrome, null, 2));
        await writeFile(resolve(OUT_DIR, "velora.json"), JSON.stringify(velora, null, 2));
        if (veloraProc?.veloraLogs) {
            await writeFile(resolve(OUT_DIR, "velora-stderr.log"), veloraProc.veloraLogs.stderr.join(""));
            await writeFile(resolve(OUT_DIR, "velora-stdout.log"), veloraProc.veloraLogs.stdout.join(""));
        }

        console.log("\n--- summary ---");
        console.log(`Chrome FP:  ${chromeSummary.fpId}`);
        console.log(`Velora FP:  ${veloraSummary.fpId}`);
        console.log(`Chrome audio/speech: ${chromeSummary.audioPassed}/${chromeSummary.speechPassed}`);
        console.log(`Velora audio/speech: ${veloraSummary.audioPassed}/${veloraSummary.speechPassed}`);
        if (chromeSummary.headless?.likeHeadless != null) {
            console.log(`Chrome headless: like ${chromeSummary.headless?.likeHeadless}% / headless ${chromeSummary.headless?.headless}%`);
            console.log(`Velora headless: like ${veloraSummary.headless?.likeHeadless}% / headless ${veloraSummary.headless?.headless}%`);
        }
        const diffs = comparison.diffs.velora_vs_chrome;
        if (diffs.length) {
            console.log("\n--- khác biệt ---");
            for (const d of diffs) {
                console.log(`  ${d.field}: chrome=${JSON.stringify(d.chrome_real)} velora=${JSON.stringify(d.velora)}`);
            }
        } else {
            console.log("\nKhông có khác biệt ở các field summary.");
        }
        console.log(`\nSaved: ${OUT_DIR}`);
    } finally {
        clearTimeout(hardKill);
        if (veloraProc && !veloraProc.killed) veloraProc.kill("SIGTERM");
        if (chromeProc && !chromeProc.killed) {
            chromeProc.kill("SIGTERM");
            await delay(1500);
            if (!chromeProc.killed) chromeProc.kill("SIGKILL");
        }
        if (staticProc && !staticProc.killed) staticProc.kill("SIGKILL");
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});