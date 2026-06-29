#!/usr/bin/env node
/** Run a single Runtime.evaluate on Velora CreepJS (max 20s). */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
    createProbeBudget,
    killProcess,
    DEFAULT_MAX_SEC,
} from "./lib/cdp-probe-budget.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VELORA = resolve(REPO, "zig-out/bin/velora");
const CREEPJS = "https://abrahamjuliot.github.io/creepjs/";
const EXPR = process.argv[2];
const MAX_SEC = DEFAULT_MAX_SEC;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

if (!EXPR) {
    console.error("usage: node scripts/cdp-velora-only-eval.mjs '<js expression>'");
    process.exit(2);
}
if (!existsSync(VELORA)) {
    console.error("zig build first");
    process.exit(2);
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

async function evalWithTimeout(cdp, sid, expression, timeoutMs) {
    const r = await Promise.race([
        cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false }, sid),
        delay(timeoutMs).then(() => null),
    ]);
    if (!r) return null;
    if (r.exceptionDetails) return null;
    return r.result?.value ?? null;
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

async function spawnVelora(port) {
    const proc = spawn(VELORA, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-local-huys-macbook-pro", "--log-level", "warn",
    ], { stdio: "pipe", cwd: REPO });
    let bootErr = "";
    proc.stderr?.on("data", (chunk) => { bootErr += String(chunk); });
    await delay(300);
    return { proc, bootErr: () => bootErr };
}

async function waitCdp(endpoint, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) return; } catch {}
        await delay(100);
    }
    throw new Error(`CDP not ready: ${endpoint}`);
}

let proc;
const budget = createProbeBudget(MAX_SEC + 10, () => killProcess(proc));

try {
    let port;
    let bootErr = () => "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
        port = await freePort();
        await delay(200);
        ({ proc, bootErr } = await spawnVelora(port));
        try {
            await waitCdp(`http://127.0.0.1:${port}`, 8000);
            break;
        } catch (err) {
            killProcess(proc);
            proc = null;
            if (attempt === 2) budget.failHang("cdp-ready", `${err.message}\n${bootErr()}`);
        }
    }

    const endpoint = `http://127.0.0.1:${port}`;
    const ver = await fetch(`${endpoint}/json/version`).then((r) => r.json());
    const ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    const cdp = new Cdp(ws);

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId: sid } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sid);
    await cdp.send("Runtime.enable", {}, sid);
    await cdp.send("Page.navigate", { url: CREEPJS }, sid);

    const deadline = Date.now() + MAX_SEC * 1000;
    let out = null;
    while (Date.now() < deadline) {
        await delay(500);
        const value = await evalWithTimeout(cdp, sid, EXPR, 8000);
        if (value != null) { out = value; break; }
    }
    cdp.close();

    if (out == null) budget.failHang("velora-eval", "expression returned null within 20s");
    console.log(JSON.stringify(out, null, 2));
} catch (err) {
    if (String(err?.message || err).includes("[HANG]")) budget.failHang("velora-eval", String(err.message || err));
    throw err;
} finally {
    budget.clear();
    killProcess(proc);
}