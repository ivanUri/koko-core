#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const SEARCH = "https://www.google.com/search?q=sgssprobe&hl=en";
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
        "--browser-profile", "chrome-macos-sonoma", "--log-level", "warn",
    ], { cwd: repoRoot, stdio: "ignore" });
    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i++) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {}
        await delay(100);
    }
    const logs = [];
    const browser = await Browser.connect(endpoint);
    try {
        const page = await browser.newPage();
        const cdp = page.session;
        await cdp.send("Runtime.enable");
        cdp.on("Runtime.consoleAPICalled", (p) => {
            logs.push({ type: p.type, text: p.args?.map((a) => a.value ?? a.description).join(" ") });
        });
        cdp.on("Runtime.exceptionThrown", (p) => {
            logs.push({ type: "exception", text: p.exceptionDetails?.text || p.exception?.description });
        });
        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await delay(2000);
        const outDir = resolve(repoRoot, "code-check/tmp/google-console");
        mkdirSync(outDir, { recursive: true });
        writeFileSync(resolve(outDir, "logs.json"), JSON.stringify({ url: await page.evaluate("location.href"), logs }, null, 2));
        console.log(`logs: ${logs.length}`);
        for (const l of logs.slice(0, 20)) console.log(`  [${l.type}] ${l.text?.slice(0, 120)}`);
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

main().catch((e) => { console.error(e); process.exit(2); });