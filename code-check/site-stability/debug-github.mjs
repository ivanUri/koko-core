#!/usr/bin/env node
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VELORA = resolve(REPO, "zig-out/bin/velora");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
    });
}

async function waitCdp(endpoint) {
    for (let i = 0; i < 80; i++) {
        try {
            if ((await fetch(`${endpoint}/json/version`)).ok) return;
        } catch {}
        await delay(100);
    }
    throw new Error("CDP not ready");
}

async function main() {
    const port = await freePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const proc = spawn(VELORA, ["serve", "--host", "127.0.0.1", "--port", String(port), "--log-level", "debug"], {
        cwd: REPO,
        stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stderr.on("data", (d) => process.stderr.write(d));
    proc.stdout.on("data", (d) => process.stderr.write(d));

    await waitCdp(endpoint);
    const { webSocketDebuggerUrl } = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });

    let id = 0;
    const pending = new Map();
    ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.id && pending.has(m.id)) {
            const { res, rej } = pending.get(m.id);
            pending.delete(m.id);
            m.error ? rej(new Error(m.error.message)) : res(m.result);
        }
    });
    ws.on("close", () => console.error("ws closed"));

    const call = (method, params = {}, sid = null) => new Promise((res, rej) => {
        const mid = ++id;
        pending.set(mid, { res, rej });
        const p = { id: mid, method, params };
        if (sid) p.sessionId = sid;
        ws.send(JSON.stringify(p));
    });

    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    await call("Runtime.enable", {}, sessionId);
    await call("Page.enable", {}, sessionId);

    console.error("navigating github...");
    await call("Page.navigate", { url: "https://github.com" }, sessionId);
    await delay(12000);

    console.error("evaluating...");
    try {
        const r = await call("Runtime.evaluate", { expression: "document.title", returnByValue: true }, sessionId);
        console.error("title:", JSON.stringify(r));
    } catch (e) {
        console.error("eval failed:", e.message);
    }

    proc.kill("SIGKILL");
    process.exit(proc.exitCode ?? 0);
}

main().catch((e) => { console.error(e); process.exit(2); });