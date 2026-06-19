#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const WORKER_URL = "https://www.google.com/recaptcha/api2/webworker.js?hl=en&v=MerVUtRoajKEbP7pLiGXkL28";
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

const BOOTSTRAP = `
globalThis.__wk = { msgs: [], errors: [], ports: 0, subtle: typeof crypto !== "undefined" && !!crypto.subtle };
const w = new Worker(${JSON.stringify(WORKER_URL)});
w.onmessage = (e) => {
    globalThis.__wk.msgs.push({ data: typeof e.data === "string" ? e.data : String(e.data), ports: e.ports?.length ?? 0 });
};
w.onerror = (e) => { globalThis.__wk.errors.push(e.message || "err"); };
"started";
`;

async function main() {
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-catalina", "--log-level", "warn",
    ], { cwd: repoRoot, stdio: "ignore" });
    for (let i = 0; i < 40; i++) {
        try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch (_) {}
        await delay(100);
    }

    const browser = await Browser.connect(`http://127.0.0.1:${port}`);
    const page = await browser.newPage();
    await page.goto("about:blank");
    await page.evaluate(BOOTSTRAP, { timeout: 15000 });

    let result = null;
    for (let i = 0; i < 60; i++) {
        await delay(500);
        result = await page.evaluate("globalThis.__wk", { timeout: 5000 });
        if (result?.msgs?.length > 0 || result?.errors?.length > 0) break;
    }

    console.log(JSON.stringify(result, null, 2));
    await browser.close();
    proc.kill("SIGTERM");
}

main().catch((e) => { console.error(e); process.exit(1); });