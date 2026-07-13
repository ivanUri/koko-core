#!/usr/bin/env node
import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VELORA = resolve(REPO, "zig-out/bin/velora");
const URL = process.argv[2] ?? "https://stackoverflow.com";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
    });
}

async function main() {
    const port = await freePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const proc = spawn(VELORA, ["serve", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warn"], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    proc.stderr.on("data", (d) => { log += d; process.stderr.write(d); });
    proc.stdout.on("data", (d) => { log += d; });

    for (let i = 0; i < 80; i++) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {}
        await delay(100);
    }

    const { webSocketDebuggerUrl } = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    ws.on("close", () => console.error("ws closed"));

    let id = 0; const pending = new Map();
    ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    });
    const call = (method, params = {}, sid = null) => new Promise((res, rej) => {
        const mid = ++id; pending.set(mid, { res, rej });
        const p = { id: mid, method, params }; if (sid) p.sessionId = sid; ws.send(JSON.stringify(p));
    });

    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    await call("Runtime.enable", {}, sessionId);
    await call("Page.enable", {}, sessionId);

    for (let run = 1; run <= 2; run++) {
        console.error(`\n=== run ${run} ===`);
        try {
            await call("Page.navigate", { url: URL }, sessionId);
            await delay(15000);
            const r = await call("Runtime.evaluate", { expression: `({title:document.title, bytes:document.documentElement.outerHTML.length})`, returnByValue: true }, sessionId);
            console.error("ok:", JSON.stringify(r.result?.value));
        } catch (e) {
            console.error("fail:", e.message);
            break;
        }
    }

    const alive = proc.exitCode == null;
    console.error("velora alive:", alive);
    if (!alive) console.error("crash log tail:\n", log.slice(-2000));
    proc.kill("SIGKILL");
}

main().catch((e) => { console.error(e); process.exit(2); });