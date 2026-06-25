#!/usr/bin/env node
/**
 * Probe local CreepJS (index.html or audio-probe.html) via Velora CDP.
 *
 * Usage:
 *   node scripts/cdp-creepjs-local-probe.mjs
 *   node scripts/cdp-creepjs-local-probe.mjs --page audio
 *   node scripts/cdp-creepjs-local-probe.mjs --max-sec 15
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
const OUT_DIR = resolve(REPO, "code-check/tmp/creepjs-local-probe");
const STATIC_PORT = 8765;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = { profile: "chrome-local-huys-macbook-pro", maxSec: 15, logLevel: "info", page: "full" };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--profile") out.profile = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
        else if (a === "--log-level") out.logLevel = argv[++i];
        else if (a === "--page") out.page = argv[++i];
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

function killTree(proc, signal = "SIGKILL") {
    if (!proc || proc.killed) return;
    try { proc.kill(signal); } catch {}
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!existsSync(VELORA_BIN)) throw new Error("zig-out/bin/velora missing — run zig build");

    await mkdir(OUT_DIR, { recursive: true });

    const staticProc = spawn(process.execPath, [
        resolve(REPO, "scripts/serve-creep-local.mjs"),
        "--port", String(STATIC_PORT),
    ], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });

    const pagePath = args.page === "audio" ? "/audio-probe.html" : "/index.html";
    const targetUrl = `http://127.0.0.1:${STATIC_PORT}${pagePath}`;

    const port = await getFreePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const logs = { stdout: [], stderr: [], static: [] };
    const t0 = Date.now();

    staticProc.stdout.on("data", (b) => logs.static.push(b.toString()));
    staticProc.stderr.on("data", (b) => logs.static.push(b.toString()));

    const veloraProc = spawn(VELORA_BIN, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", args.profile, "--log-level", args.logLevel,
    ], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });

    veloraProc.stdout.on("data", (b) => logs.stdout.push(b.toString()));
    veloraProc.stderr.on("data", (b) => logs.stderr.push(b.toString()));

    const hardTimer = setTimeout(() => {
        console.error(`\n[HARD LIMIT ${args.maxSec}s] killing velora`);
        killTree(veloraProc, "SIGKILL");
    }, args.maxSec * 1000);

    const samples = [];
    let killed = false;
    let error = null;

    try {
        await delay(300);

        for (let i = 0; i < 80; i += 1) {
            if (Date.now() - t0 >= args.maxSec * 1000) break;
            try {
                if ((await fetch(`${endpoint}/json/version`)).ok) break;
            } catch {}
            await delay(100);
        }

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
        await client.send("Log.enable", {}, sessionId).catch(() => {});

        console.log(`navigate: ${targetUrl}`);
        await client.send("Page.navigate", { url: targetUrl }, sessionId);

        const pollExpr = args.page === "audio"
            ? `(() => ({
                ready: document.readyState,
                status: document.getElementById('status')?.textContent ?? null,
                passed: (document.getElementById('status')?.textContent ?? '').startsWith('PASS'),
                result: window.AUDIO_PROBE_RESULT ?? null,
                logLines: document.getElementById('log')?.children?.length ?? 0,
            }))()`
            : `(() => ({
                ready: document.readyState,
                bodyLen: document.body?.innerText?.length ?? 0,
                hasFp: (document.body?.innerText ?? "").includes("FP ID:"),
                audioPassed: (document.body?.innerText ?? "").includes("audio passed"),
                speechPassed: (document.body?.innerText ?? "").includes("speech passed"),
                logLines: document.getElementById('debug-log')?.children?.length ?? 0,
            }))()`;

        while (Date.now() - t0 < args.maxSec * 1000) {
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            try {
                const r = await Promise.race([
                    client.send("Runtime.evaluate", { expression: pollExpr, returnByValue: true }, sessionId),
                    delay(3000).then(() => { throw new Error("evaluate timeout 3s"); }),
                ]);
                const v = r.result?.value ?? null;
                samples.push({ elapsedSec: Number(elapsed), ...v });
                if (args.page === "audio") {
                    console.log(`[${elapsed}s] status=${v?.status} passed=${v?.passed} logLines=${v?.logLines}`);
                    if (v?.passed) {
                        console.log("audio probe PASS", v?.result);
                        break;
                    }
                } else {
                    console.log(`[${elapsed}s] body=${v?.bodyLen} audio=${v?.audioPassed} speech=${v?.speechPassed} logs=${v?.logLines}`);
                    if (v?.audioPassed) {
                        console.log("audio passed in full creep");
                        break;
                    }
                }
            } catch (e) {
                samples.push({ elapsedSec: Number(elapsed), error: String(e.message || e) });
                console.log(`[${elapsed}s] ERROR: ${e.message || e}`);
            }
            await delay(500);
        }

        client.close();
    } catch (e) {
        error = String(e.message || e);
        console.error("probe error:", error);
    } finally {
        clearTimeout(hardTimer);
        killTree(veloraProc, "SIGTERM");
        killTree(staticProc, "SIGTERM");
        await delay(400);
        if (!veloraProc.killed) { killTree(veloraProc, "SIGKILL"); killed = true; }
        if (!staticProc.killed) killTree(staticProc, "SIGKILL");
    }

    const elapsedMs = Date.now() - t0;
    const report = {
        at: new Date().toISOString(),
        profile: args.profile,
        page: args.page,
        targetUrl,
        maxSec: args.maxSec,
        elapsedMs,
        killed,
        error,
        samples,
        veloraLog: { stdout: logs.stdout.join(""), stderr: logs.stderr.join("") },
        staticLog: logs.static.join(""),
    };

    const outPath = resolve(OUT_DIR, `report-${args.page}.json`);
    await writeFile(outPath, JSON.stringify(report, null, 2));
    await writeFile(resolve(OUT_DIR, "velora-stderr.log"), report.veloraLog.stderr);
    await writeFile(resolve(OUT_DIR, "velora-stdout.log"), report.veloraLog.stdout);

    console.log(`\n--- velora stderr (last 60 lines) ---`);
    console.log(report.veloraLog.stderr.split("\n").filter(Boolean).slice(-60).join("\n") || "(empty)");
    console.log(`\nsaved: ${outPath} (${elapsedMs}ms)`);

    const passed = args.page === "audio"
        ? samples.some((s) => s.passed)
        : samples.some((s) => s.audioPassed);
    process.exitCode = passed ? 0 : 1;
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});