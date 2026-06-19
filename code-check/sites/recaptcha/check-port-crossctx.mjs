#!/usr/bin/env node
// Simulates anchor iframe: Worker transfers port2 to page, then bidirectional MessagePort traffic.
import { spawn } from "node:child_process";
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
    "ch.port1.onmessage = (e) => {",
    "  ch.port1.postMessage('worker-got:' + e.data);",
    "};",
    "ch.port1.start();",
].join("\n");

const BOOTSTRAP = `
globalThis.__pt = { done: null, err: null, steps: [] };
const workerSrc = ${JSON.stringify(WORKER_SRC)};
const w = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: "application/javascript" })));
w.onmessage = (e) => {
    globalThis.__pt.steps.push("wm:" + e.data);
    if (e.data !== "setup") return;
    const port = e.ports[0];
    if (!port) { globalThis.__pt.err = "no-port"; return; }
    port.onmessage = (ev) => {
        globalThis.__pt.steps.push("port:" + ev.data);
        if (String(ev.data).startsWith("worker-got:")) {
            globalThis.__pt.done = { ok: true, data: ev.data };
        }
    };
    port.start();
    port.postMessage("execute-cmd");
};
w.onerror = (e) => { globalThis.__pt.err = e.message || "err"; };
"started";
`;

async function main() {
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-catalina", "--log-level", "error",
    ], { cwd: repoRoot, stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch (_) {}
        await delay(100);
    }

    const browser = await Browser.connect(`http://127.0.0.1:${port}`);
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.evaluate(BOOTSTRAP, { timeout: 10000 });

    let result = null;
    for (let i = 0; i < 40; i++) {
        await delay(250);
        result = await page.evaluate("globalThis.__pt", { timeout: 5000 });
        if (result?.done || result?.err) break;
    }

    console.log(JSON.stringify(result, null, 2));
    await browser.close();
    proc.kill("SIGTERM");
    process.exit(result?.done?.ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });