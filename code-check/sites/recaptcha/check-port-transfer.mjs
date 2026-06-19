#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

const WORKER_SRC = [
    "const ch = new MessageChannel();",
    "self.postMessage('setup', [ch.port2]);",
    "self.onmessage = (e) => { ch.port1.postMessage('via-port:' + e.data); };",
].join("\n");

const BOOTSTRAP = `
globalThis.__portTest = { done: null, err: null, log: [] };
const workerSrc = ${JSON.stringify(WORKER_SRC)};
const blob = new Blob([workerSrc], { type: "application/javascript" });
const url = URL.createObjectURL(blob);
let parentPort = null;
const w = new Worker(url);
w.onmessage = (e) => {
    globalThis.__portTest.log.push("wm:" + String(e.data) + ":ports=" + (e.ports?.length ?? 0));
    if (e.data === "setup") {
        parentPort = e.ports[0];
        if (!parentPort) { globalThis.__portTest.err = "no-port"; return; }
        parentPort.start();
        parentPort.onmessage = (ev) => {
            globalThis.__portTest.done = { via: ev.data, portsLen: e.ports.length };
        };
        parentPort.postMessage("hello");
        w.postMessage("to-worker");
    }
};
w.onerror = (e) => { globalThis.__portTest.err = e.message || "worker-error"; };
"started";
`;

async function main() {
    const port = await getFreePort();
    const logPath = "/tmp/velora-port-test.log";
    const logStream = createWriteStream(logPath);
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-catalina", "--log-level", "info",
    ], { cwd: repoRoot });
    proc.stdout.pipe(logStream);
    proc.stderr.pipe(logStream);
    for (let i = 0; i < 40; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch (_) {}
        await delay(100);
    }

    const browser = await Browser.connect(`http://127.0.0.1:${port}`);
    const page = await browser.newPage();
    await page.goto("about:blank");

    const started = await page.evaluate(BOOTSTRAP, { timeout: 10000 });
    console.log("bootstrap:", started);

    let result = null;
    for (let i = 0; i < 40; i++) {
        await delay(250);
        result = await page.evaluate("globalThis.__portTest", { timeout: 5000 });
        if (result?.done || result?.err) break;
    }

    console.log(JSON.stringify(result, null, 2));
    await browser.close();
    proc.kill("SIGTERM");
    await delay(500);
    const { execSync } = await import("node:child_process");
    console.log("\n=== VELORA LOG (worker/postMessage) ===");
    try {
        console.log(execSync(`grep -E "worker|postMessage|importScript|error" ${logPath} | tail -40`, { encoding: "utf8" }));
    } catch (_) {}
    process.exit(result?.done?.via === "via-port:to-worker" ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });