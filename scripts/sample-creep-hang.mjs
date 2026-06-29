#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { writeFile } from "node:fs/promises";
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
    const port = await freePort();
    const velora = spawn(VELORA, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-local-huys-macbook-pro", "--log-level", "warn",
    ], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });

    await delay(600);
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
    const send = (method, params = {}) => new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
    });

    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    await send("Page.navigate", { url: "http://127.0.0.1:8765/index.html" }, sessionId);
    console.log("navigated, pumping CDP while waiting for hang...");
    const pump = setInterval(() => {
        send("Runtime.evaluate", {
            expression: "document.readyState",
            returnByValue: true,
        }, sessionId).catch(() => {});
    }, 400);
    await delay(3500);
    clearInterval(pump);

    const sampleOut = "/tmp/velora-hang.sample.txt";
    await new Promise((res) => {
        const sample = spawn("sample", [String(velora.pid), "1", "-file", sampleOut], { stdio: "inherit" });
        sample.on("close", () => res());
    });

    const { readFile } = await import("node:fs/promises");
    const text = await readFile(sampleOut, "utf8").catch(() => "");
    const hits = text.split("\n").filter((l) =>
        /velora|PerformCheckpoint|v8__|Element|Canvas|Audio|getChannel|TypedArray|Iterator|microtask/i.test(l)
    ).slice(0, 60);
    console.log(hits.join("\n") || "(no velora frames in sample)");
    await writeFile(resolve(REPO, "code-check/tmp/creepjs-local-probe/hang-sample.txt"), text.slice(0, 200000));

    velora.kill("SIGKILL");
    ws.close();
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });