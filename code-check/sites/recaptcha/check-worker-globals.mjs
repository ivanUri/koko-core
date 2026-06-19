#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { resolve, dirname } from "node:path";
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

async function main() {
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-catalina", "--log-level", "warn",
    ], { cwd: repoRoot, stdio: "ignore" });
    await delay(1500);
    const browser = await Browser.connect(`http://127.0.0.1:${port}`);
    const page = await browser.newPage();

    const pageGlobals = await page.evaluate(() => {
        const checks = {};
        for (const k of ["SharedArrayBuffer", "Atomics", "WebAssembly", "OffscreenCanvas", "performance", "Worker", "WorkerGlobalScope"]) {
            try { checks[k] = typeof globalThis[k]; } catch { checks[k] = "err"; }
        }
        return checks;
    });

    const workerGlobals = await page.evaluate(async () => {
        const code = `onmessage=()=>{const c={};for(const k of ["SharedArrayBuffer","Atomics","WebAssembly","OffscreenCanvas","performance","importScripts","WorkerGlobalScope","DedicatedWorkerGlobalScope","crypto","indexedDB","document","window","self","name","location","navigator"]) {try{c[k]=typeof globalThis[k]}catch(e){c[k]="err"}} postMessage(c)}`;
        const blob = new Blob([code], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        return new Promise((res, rej) => {
            const wk = new Worker(url);
            wk.onmessage = (e) => { URL.revokeObjectURL(url); res(e.data); };
            wk.onerror = (e) => rej(e.message || "worker error");
            wk.postMessage("go");
            setTimeout(() => rej("timeout"), 5000);
        });
    }, { timeout: 10000 });

    console.log("PAGE:", JSON.stringify(pageGlobals, null, 2));
    console.log("WORKER:", JSON.stringify(workerGlobals, null, 2));

    await browser.close();
    proc.kill("SIGTERM");
}

main().catch((e) => { console.error(e); process.exit(1); });