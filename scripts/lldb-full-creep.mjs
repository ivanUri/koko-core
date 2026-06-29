#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA = resolve(REPO, "zig-out/bin/velora");
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

async function main() {
    const port = Number(process.env.VELORA_PORT || 0) || await freePort();
    const velora = spawn(VELORA, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-local-huys-macbook-pro", "--log-level", "warn",
    ], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });

    velora.stderr.on("data", (d) => process.stderr.write(d));
    velora.on("exit", (code, sig) => console.log("velora exit", code, sig));

    await delay(800);
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });

    let nextId = 1;
    const pending = new Map();
    ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.id && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
        }
    });
    const send = (method, params = {}, sessionId = null) => new Promise((resolve) => {
        const id = nextId++;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        pending.set(id, resolve);
        ws.send(JSON.stringify(payload));
    });

    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.navigate", { url: "http://127.0.0.1:8765/index.html" }, sessionId);
    console.log("navigated, waiting for crash...");
    await delay(8000);
    ws.close();
    velora.kill("SIGTERM");
}

main().catch(console.error);