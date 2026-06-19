#!/usr/bin/env node
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

const TESTS = [
    ["top-level-this", `postMessage('top:' + (typeof this) + ':' + (this===self));`],
    ["iife-call-this", `(function(){postMessage('iife:' + (typeof this) + ':' + (this===self));}).call(this);`],
    ["iife-call-globalThis", `(function(){postMessage('gt:' + (typeof this) + ':' + (this===self));}).call(globalThis);`],
];

async function runWorker(page, code) {
    return page.evaluate(async (workerCode) => {
        const blob = new Blob([workerCode], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        return new Promise((res) => {
            const msgs = [];
            const wk = new Worker(url);
            wk.onmessage = (e) => msgs.push(String(e.data));
            wk.onerror = (e) => msgs.push("ERR:" + (e.message || "error"));
            setTimeout(() => { URL.revokeObjectURL(url); res(msgs); }, 3000);
        });
    }, code, { timeout: 8000 });
}

async function main() {
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-catalina", "--log-level", "warn",
    ], { cwd: repoRoot, stdio: "ignore" });
    await delay(1500);

    const browser = await Browser.connect(`http://127.0.0.1:${port}`);
    const page = await browser.newPage();

    for (const [name, code] of TESTS) {
        try {
            const result = await runWorker(page, code);
            console.log(name, result);
        } catch (e) {
            console.log(name, "TIMEOUT/FAIL", e.message);
        }
    }

    await browser.close();
    proc.kill("SIGTERM");
}

main().catch((e) => { console.error(e); process.exit(1); });