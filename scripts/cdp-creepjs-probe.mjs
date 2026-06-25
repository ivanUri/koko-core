#!/usr/bin/env node
/**
 * Load CreepJS via raw CDP and capture fingerprint / trust signals.
 *
 * Usage:
 *   node scripts/cdp-creepjs-probe.mjs --profile chrome-local-huys-macbook-pro
 *   node scripts/cdp-creepjs-probe.mjs --endpoint http://127.0.0.1:9222
 */

import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const CREEPJS_URL = "https://abrahamjuliot.github.io/creepjs/";
const OUT_DIR = resolve(REPO, "code-check/tmp/creepjs-probe");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = { profile: "chrome-local-huys-macbook-pro", endpoint: null, port: null, waitSec: 15, maxSec: 15, keep: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--profile") out.profile = argv[++i];
        else if (a === "--endpoint") out.endpoint = argv[++i];
        else if (a === "--port") out.port = Number(argv[++i]);
        else if (a === "--wait-sec") out.waitSec = Number(argv[++i]);
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
        else if (a === "--keep") out.keep = true;
    }
    return out;
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

async function connectVelora(endpoint) {
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
    return { client, sessionId, targetId };
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
    proc.stdout.on("data", (b) => proc.veloraLogs.stdout.push(b.toString()));
    proc.stderr.on("data", (b) => proc.veloraLogs.stderr.push(b.toString()));
    const endpoint = `http://127.0.0.1:${port}`;
    await waitCdp(endpoint);
    return { proc, endpoint };
}

const EXTRACT_CREEPJS = `(() => {
    const body = document.body?.innerText ?? "";
    const line = (prefix) => body.split("\\n").find((l) => l.startsWith(prefix)) ?? "";
    const after = (label) => {
        const i = body.indexOf(label);
        if (i < 0) return null;
        return body.slice(i, i + 400).replace(/\\s+/g, " ").trim();
    };
    const pct = (label) => {
        const block = after(label);
        if (!block) return null;
        const m = block.match(/(\\d+(?:\\.\\d+)?)%/);
        return m ? Number(m[1]) : null;
    };
    const fpId = line("FP ID:").replace(/^FP ID:\\s*/, "");
    return {
        fpId,
        fuzzy: line("Fuzzy:").replace(/^Fuzzy:\\s*/, ""),
        ready: fpId.length > 0 && !fpId.includes("Computing"),
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
        canvas: after("Canvas 2d"),
        fonts: after("Fonts"),
        audio: after("Audio"),
        worker: after("Worker"),
        lies: (body.match(/\\blies?\\b/gi) || []).length,
        trash: (body.match(/\\btrash\\b/gi) || []).length,
        bodyLen: body.length,
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

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.endpoint && !existsSync(VELORA_BIN)) {
        throw new Error("zig build first — zig-out/bin/velora missing");
    }

    let proc = null;
    let endpoint = args.endpoint;
    if (!endpoint) {
        const port = args.port ?? await getFreePort();
        ({ proc, endpoint } = await spawnVelora(args.profile, port));
        console.log(`velora serve: ${endpoint}  profile=${args.profile}`);
    } else {
        await waitCdp(endpoint.replace(/\/$/, ""));
        console.log(`attach CDP: ${endpoint}`);
    }

    let client = null;
    const t0 = Date.now();
    const hardTimer = !args.keep ? setTimeout(() => {
        console.error(`\n[HARD LIMIT ${args.maxSec}s] killing velora`);
        if (proc && !proc.killed) proc.kill("SIGKILL");
    }, args.maxSec * 1000) : null;
    try {
        const conn = await connectVelora(endpoint);
        client = conn.client;

        console.log(`navigate: ${CREEPJS_URL}`);
        await client.send("Page.navigate", { url: CREEPJS_URL }, conn.sessionId);

        let creep = null;
        const maxPolls = Math.max(10, args.waitSec);
        for (let i = 0; i < maxPolls; i += 1) {
            await delay(1000);
            creep = await evaluate(client, conn.sessionId, EXTRACT_CREEPJS);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
            process.stdout.write(`\r[${elapsed}s] fpId=${(creep?.fpId || "").slice(0, 20)} ready=${creep?.ready}`);
            if (creep?.ready && creep.bodyLen > 3000) break;
        }
        console.log("");

        const navigator = await evaluate(client, conn.sessionId, EXTRACT_NAV);
        const report = {
            at: new Date().toISOString(),
            profile: args.profile,
            url: CREEPJS_URL,
            elapsedMs: Date.now() - t0,
            creepjs: creep,
            navigator,
        };

        await mkdir(OUT_DIR, { recursive: true });
        const outPath = resolve(OUT_DIR, "report.json");
        await writeFile(outPath, JSON.stringify(report, null, 2));
        if (proc?.veloraLogs) {
            await writeFile(resolve(OUT_DIR, "velora-stderr.log"), proc.veloraLogs.stderr.join(""));
            await writeFile(resolve(OUT_DIR, "velora-stdout.log"), proc.veloraLogs.stdout.join(""));
        }

        console.log(JSON.stringify(report, null, 2));
        console.log(`\nsaved: ${outPath}`);

        const headlessOk = (creep?.headless?.headless ?? 0) === 0 && (creep?.headless?.likeHeadless ?? 0) === 0;
        const fpReady = creep?.ready === true;
        process.exitCode = fpReady && headlessOk ? 0 : 1;
    } finally {
        if (hardTimer) clearTimeout(hardTimer);
        client?.close();
        if (proc && !args.keep) {
            if (!proc.killed) proc.kill("SIGTERM");
            if (proc.veloraLogs?.stderr.length) {
                const lines = proc.veloraLogs.stderr.join("").split("\n").filter(Boolean);
                console.log("\n--- velora stderr (last 40 lines) ---");
                console.log(lines.slice(-40).join("\n") || "(empty)");
            }
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});