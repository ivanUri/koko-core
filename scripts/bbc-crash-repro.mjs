#!/usr/bin/env node
// Minimal CDP navigate to BBC for crash reproduction under lldb.

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VELORA = resolve(REPO, "zig-out/bin/velora");
const args = process.argv.slice(2).filter((a) => !a.startsWith("--port=") && a !== "--block-optimizely");
const PORT_ARG = process.argv.find((a) => a.startsWith("--port="));
const FIXED_PORT = PORT_ARG ? Number(PORT_ARG.split("=")[1]) : null;
const BLOCK_OPTIMIZELY = process.argv.includes("--block-optimizely");
const URL = args[0] ?? "https://www.bbc.com/news";

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

async function cdpCall(ws, method, params = {}, sessionId = null) {
    const id = Math.floor(Math.random() * 1e9);
    return new Promise((res, rej) => {
        const onMsg = (raw) => {
            const m = JSON.parse(String(raw));
            if (m.id !== id) return;
            ws.off("message", onMsg);
            if (m.error) rej(new Error(`${method}: ${m.error.message}`));
            else res(m.result ?? {});
        };
        ws.on("message", onMsg);
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        ws.send(JSON.stringify(payload));
    });
}

export async function main() {
    const port = FIXED_PORT ?? await freePort();
    const endpoint = `http://127.0.0.1:${port}`;

    let proc = null;
    if (!FIXED_PORT) {
        proc = spawn(VELORA, ["serve", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warn"], {
            cwd: REPO,
            stdio: ["ignore", "pipe", "pipe"],
        });
        proc.stderr.on("data", (d) => process.stderr.write(d));
        proc.stdout.on("data", (d) => process.stderr.write(d));
    }

    for (let i = 0; i < 80; i++) {
        try {
            if ((await fetch(`${endpoint}/json/version`)).ok) break;
        } catch (_) {}
        await delay(100);
    }

    const { webSocketDebuggerUrl } = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.once("open", res);
        ws.once("error", rej);
    });

    const { targetId } = await cdpCall(ws, "Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdpCall(ws, "Target.attachToTarget", { targetId, flatten: true });
    await cdpCall(ws, "Runtime.enable", {}, sessionId);
    await cdpCall(ws, "Page.enable", {}, sessionId);

    if (BLOCK_OPTIMIZELY) {
        await cdpCall(ws, "Fetch.enable", {
            patterns: [{ urlPattern: "*optimizely*", requestStage: "Request" }],
        }, sessionId);
        ws.on("message", async (raw) => {
            const m = JSON.parse(String(raw));
            if (m.method !== "Fetch.requestPaused" || m.sessionId !== sessionId) return;
            await cdpCall(ws, "Fetch.failRequest", {
                requestId: m.params.requestId,
                errorReason: "BlockedByClient",
            }, sessionId);
        });
        console.error("[repro] blocking *optimizely* requests");
    }

    console.error(`[repro] navigate ${URL}`);
    const nav = await cdpCall(ws, "Page.navigate", { url: URL }, sessionId);
    console.error("[repro] nav ok:", JSON.stringify(nav));

    const started = Date.now();
    while (Date.now() - started < 20000) {
        if (proc && proc.exitCode != null) {
            console.error(`[repro] velora exited code=${proc.exitCode} signal=${proc.signalCode}`);
            process.exit(proc.signalCode ? 3 : proc.exitCode);
        }
        if (ws.readyState !== WebSocket.OPEN) {
            console.error("[repro] ws closed");
            process.exit(3);
        }
        await delay(250);
    }

    try {
        const r = await cdpCall(ws, "Runtime.evaluate", {
            expression: `({title:document.title, bytes:document.documentElement?.outerHTML?.length??0})`,
            returnByValue: true,
        }, sessionId);
        console.error("[repro] extract ok:", JSON.stringify(r.result?.value));
        process.exit(0);
    } catch (e) {
        console.error("[repro] extract fail:", e.message);
        process.exit(2);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}