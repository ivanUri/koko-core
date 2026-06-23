#!/usr/bin/env node
import { spawn } from "node:child_process";
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
        s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
    });
}

async function main() {
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-catalina", "--log-level", "error",
    ], { cwd: repoRoot, stdio: "ignore" });
    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 150; i++) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch (_) {}
        await delay(100);
    }

    const browser = await Browser.connect(endpoint);
    try {
        const page = await browser.newPage();
        await page.goto("https://www.google.com/search?q=velora+browser&hl=en", {
            waitUntil: "domcontentloaded", timeout: 60000,
        });
        await delay(2000);
        let r;
        try {
            r = await page.evaluate(`({
                url: location.href,
                sorry: location.href.includes('/sorry'),
                hits: document.querySelectorAll('#search .g h3, #rso .g h3').length,
            })`);
        } catch {
            const { result } = await page.session.send("Runtime.evaluate", {
                expression: "location.href",
                returnByValue: true,
            }).catch(() => ({ result: { value: "unknown" } }));
            const url = result?.value ?? "unknown";
            r = { url, sorry: String(url).includes("/sorry"), hits: 0, evalFailed: true };
        }
        console.log(JSON.stringify(r, null, 2));
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

main().catch((e) => { console.error(e); process.exit(1); });