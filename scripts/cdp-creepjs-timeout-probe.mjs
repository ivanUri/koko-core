#!/usr/bin/env node
/**
 * Probe CreepJS via Velora with hard timeout. Kills velora if over budget.
 *
 * Usage:
 *   node scripts/cdp-creepjs-timeout-probe.mjs
 *   node scripts/cdp-creepjs-timeout-probe.mjs --max-sec 20
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
const OUT_DIR = resolve(REPO, "code-check/tmp/creepjs-timeout-probe");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = { profile: "chrome-local-huys-macbook-pro", maxSec: 15, logLevel: "info" };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--profile") out.profile = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
        else if (a === "--log-level") out.logLevel = argv[++i];
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
    try {
        proc.kill(signal);
    } catch {}
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!existsSync(VELORA_BIN)) throw new Error("zig-out/bin/velora missing — run zig build");

    await mkdir(OUT_DIR, { recursive: true });

    const port = await getFreePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const logs = { stdout: [], stderr: [] };
    const t0 = Date.now();

    const proc = spawn(VELORA_BIN, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", args.profile, "--log-level", args.logLevel,
    ], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });

    proc.stdout.on("data", (buf) => logs.stdout.push(buf.toString()));
    proc.stderr.on("data", (buf) => logs.stderr.push(buf.toString()));

    const hardTimer = setTimeout(() => {
        console.error(`\n[HARD LIMIT ${args.maxSec}s] killing velora`);
        killTree(proc, "SIGKILL");
    }, args.maxSec * 1000);

    const samples = [];
    let killed = false;
    let error = null;

    try {
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

        console.log(`navigate: ${CREEPJS_URL}`);
        await client.send("Page.navigate", { url: CREEPJS_URL }, sessionId);

        const pollExpr = `(() => ({
            ready: document.readyState,
            title: document.title,
            bodyLen: document.body?.innerText?.length ?? 0,
            hasFp: (document.body?.innerText ?? "").includes("FP ID:"),
            hasHeadless: (document.body?.innerText ?? "").includes("Headless"),
            fpLine: (document.body?.innerText ?? "").split("\\n").find(l => l.startsWith("FP ID:")) ?? null,
            scripts: document.scripts?.length ?? 0,
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
                console.log(`[${elapsed}s] ready=${v?.ready} body=${v?.bodyLen} fp=${v?.hasFp} headless=${v?.hasHeadless} scripts=${v?.scripts}`);
                if (v?.hasFp && v?.hasHeadless && v?.bodyLen > 2500) {
                    console.log("done early — creepjs stable");
                    break;
                }
            } catch (e) {
                samples.push({ elapsedSec: Number(elapsed), error: String(e.message || e) });
                console.log(`[${elapsed}s] ERROR: ${e.message || e}`);
            }
            await delay(1000);
        }

        client.close();
    } catch (e) {
        error = String(e.message || e);
        console.error("probe error:", error);
    } finally {
        clearTimeout(hardTimer);
        if (!proc.killed) {
            proc.kill("SIGTERM");
            await delay(400);
            if (!proc.killed) {
                proc.kill("SIGKILL");
                killed = true;
            }
        }
    }

    const elapsedMs = Date.now() - t0;
    const report = {
        at: new Date().toISOString(),
        profile: args.profile,
        maxSec: args.maxSec,
        elapsedMs,
        killed,
        error,
        samples,
        veloraLog: {
            stdout: logs.stdout.join(""),
            stderr: logs.stderr.join(""),
        },
    };

    const outPath = resolve(OUT_DIR, "report.json");
    await writeFile(outPath, JSON.stringify(report, null, 2));
    await writeFile(resolve(OUT_DIR, "velora-stdout.log"), report.veloraLog.stdout);
    await writeFile(resolve(OUT_DIR, "velora-stderr.log"), report.veloraLog.stderr);

    console.log(`\n--- velora stderr (last 80 lines) ---`);
    const errLines = report.veloraLog.stderr.split("\n").filter(Boolean);
    console.log(errLines.slice(-80).join("\n") || "(empty)");

    console.log(`\n--- velora stdout (last 40 lines) ---`);
    const outLines = report.veloraLog.stdout.split("\n").filter(Boolean);
    console.log(outLines.slice(-40).join("\n") || "(empty)");

    console.log(`\nsaved: ${outPath} (${elapsedMs}ms, killed=${killed})`);
    process.exitCode = samples.some((s) => s.hasFp && s.hasHeadless) ? 0 : 1;
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});