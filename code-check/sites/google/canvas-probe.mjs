#!/usr/bin/env node
// Quick local canvas + csi + speech probe (no Google network).
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");

const PROBE = `(() => {
    const canvas = (() => {
        const c = document.createElement("canvas");
        c.width = 240; c.height = 60;
        const ctx = c.getContext("2d");
        ctx.font = "14px Arial";
        ctx.fillText("velora", 2, 2);
        const url = c.toDataURL();
        return { tail: url.slice(-32), len: url.length };
    })();
    const voicesNow = speechSynthesis.getVoices().length;
    const csi = chrome.csi();
    return { canvas, voicesNow, csi, perfNow: performance.now() };
})()`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function getFreePort() {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.unref();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
    });
}

async function main() {
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-sonoma", "--log-level", "warn",
    ], { cwd: repoRoot, stdio: "ignore" });
    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i++) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {}
        await delay(100);
    }
    const browser = await Browser.connect(endpoint);
    try {
        const page = await browser.newPage();
        await page.goto("about:blank");
        await delay(500);
        const probe = await page.evaluate(PROBE);
        console.log(JSON.stringify(probe, null, 2));
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

main().catch((e) => { console.error(e); process.exit(2); });