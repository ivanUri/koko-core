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
    await page.goto("https://antcpt.com/score_detector/", { waitUntil: "load", timeout: 90000 });
    await delay(3000);

    const r = await page.evaluate(`(() => {
        const iframe = document.querySelector("iframe");
        if (!iframe) return { err: "no-iframe" };
        const cw = iframe.contentWindow;
        if (!cw) return { err: "no-contentWindow" };
        globalThis.__pm = [];
        window.addEventListener("message", (e) => {
            globalThis.__pm.push({ dir: "in", data: String(e.data), origin: e.origin });
        });
        try {
            cw.postMessage("parent-to-iframe", "*");
        } catch (e) {
            return { err: "post-fail:" + e };
        }
        return { ok: true, cwType: typeof cw, hasPostMessage: typeof cw.postMessage };
    })()`, { timeout: 10000 });

    await delay(1000);
    const pm = await page.evaluate("globalThis.__pm", { timeout: 5000 });
    console.log("post:", JSON.stringify(r));
    console.log("msgs:", JSON.stringify(pm));

    await browser.close();
    proc.kill("SIGTERM");
}

main().catch((e) => { console.error(e); process.exit(1); });