#!/usr/bin/env node
import { spawn, execSync } from "node:child_process";
import { createWriteStream } from "node:fs";
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

async function main() {
    const port = await getFreePort();
    const logPath = "/tmp/velora-exec-test.log";
    const logStream = createWriteStream(logPath);
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-catalina", "--log-level", "warn",
    ], { cwd: repoRoot });
    proc.stdout.pipe(logStream);
    proc.stderr.pipe(logStream);
    for (let i = 0; i < 40; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch (_) {}
        await delay(100);
    }

    const browser = await Browser.connect(`http://127.0.0.1:${port}`);
    const page = await browser.newPage();

    await page.goto(TARGET, { waitUntil: "load", timeout: 90000 });
    await delay(5000);

    await page.evaluate(`
        globalThis.__msgs = [];
        window.addEventListener("message", (e) => {
            let p = "";
            try { p = typeof e.data === "string" ? e.data.slice(0,80) : JSON.stringify(e.data)?.slice(0,80) ?? ""; } catch(_){}
            globalThis.__msgs.push({ origin: e.origin, preview: p, ports: e.ports?.length ?? 0 });
        }, true);
    `, { timeout: 10000 });

    const exec = await page.evaluate(`(async () => {
        const t0 = Date.now();
        let token = null, err = null;
        try {
            token = await grecaptcha.execute("${SITEKEY}", { action: "homepage" });
        } catch (e) { err = String(e); }
        return { tokenLen: token?.length ?? 0, prefix: token?.slice(0, 20), err, ms: Date.now() - t0 };
    })()`, { timeout: 120000 });

    const msgs = await page.evaluate("globalThis.__msgs", { timeout: 5000 });

    console.log("execute:", JSON.stringify(exec));
    console.log("messages:", JSON.stringify(msgs, null, 2));

    await browser.close();
    proc.kill("SIGTERM");
    await delay(500);

    console.log("\n=== ERRORS ===");
    try {
        console.log(execSync(`grep -iE "error|importScript|worker script|unhandled|reportError" ${logPath} | tail -30`, { encoding: "utf8" }));
    } catch (_) { console.log("(none)"); }
}

main().catch((e) => { console.error(e); process.exit(1); });