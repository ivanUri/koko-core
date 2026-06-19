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
        "--browser-profile", "chrome-macos-catalina", "--log-level", "warn",
    ], { cwd: repoRoot, stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try {
            if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
        } catch (_) {}
        await delay(100);
    }

    const browser = await Browser.connect(`http://127.0.0.1:${port}`);
    const page = await browser.newPage();

    const result = await page.evaluate(() => {
        return new Promise((resolve) => {
            const code = `postMessage("pong"); self.onmessage = () => postMessage("pong2");`;
            const blob = new Blob([code], { type: "application/javascript" });
            const url = URL.createObjectURL(blob);
            const out = { msgs: [], errors: [] };
            const w = new Worker(url);
            w.onmessage = (e) => {
                out.msgs.push(String(e.data));
                if (out.msgs.length === 1) w.postMessage("ping");
                if (out.msgs.length >= 2) { URL.revokeObjectURL(url); resolve(out); }
            };
            w.onerror = (e) => { out.errors.push(e.message || "err"); resolve(out); };
            setTimeout(() => { URL.revokeObjectURL(url); resolve({ ...out, timeout: true }); }, 5000);
        });
    }, { timeout: 10000 });

    console.log(JSON.stringify(result, null, 2));
    await browser.close();
    proc.kill("SIGTERM");
}

main().catch((e) => { console.error(e); process.exit(1); });