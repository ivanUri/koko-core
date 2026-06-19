#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const TARGET = "https://antcpt.com/score_detector/";
const SITEKEY = "6LcR_okUAAAAAPYrPe-HK_0RULO1aZM15ENyM-Mf";
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

async function runExecute(waitMs) {
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
    await page.goto(TARGET, { waitUntil: "load", timeout: 90000 });
    await delay(waitMs);

    const exec = await page.evaluate(`(async () => {
        const t0 = Date.now();
        const token = await grecaptcha.execute("${SITEKEY}", { action: "homepage" });
        return { len: token.length, prefix: token.slice(0, 15), ms: Date.now() - t0 };
    })()`, { timeout: 120000 });

    await browser.close();
    proc.kill("SIGTERM");
    return exec;
}

async function main() {
    for (const wait of [1000, 3000, 22000]) {
        const r = await runExecute(wait);
        console.log(`wait=${wait}ms ->`, JSON.stringify(r));
    }
}

main().catch((e) => { console.error(e); process.exit(1); });