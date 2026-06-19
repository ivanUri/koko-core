#!/usr/bin/env node
// After recaptcha-setup, post execute command directly on the transferred MessagePort.
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const TARGET = "https://antcpt.com/score_detector/";
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

const SCRIPT = `
(async () => {
    const out = { setup: false, portReply: null, portErr: null, exec: null };
    let port = null;

    await new Promise((resolve) => {
        const t = setTimeout(resolve, 12000);
        window.addEventListener("message", (e) => {
            if (e.data === "recaptcha-setup" && e.ports?.[0]) {
                port = e.ports[0];
                port.onmessage = (ev) => { out.portReply = String(ev.data).slice(0, 120); };
                port.onmessageerror = () => { out.portErr = "messageerror"; };
                port.start();
                out.setup = true;
                clearTimeout(t);
                resolve();
            }
        }, true);
    });

    if (!port) return out;

    // Try posting execute-shaped payloads observed in reCAPTCHA v3
    const payloads = [
        ["execute", 0, "homepage", null],
        { type: "execute", action: "homepage" },
        "execute",
    ];
    for (const p of payloads) {
        try { port.postMessage(p); } catch (e) { out.portErr = String(e); }
        await new Promise((r) => setTimeout(r, 2000));
        if (out.portReply) break;
    }

    const t0 = Date.now();
    try {
        const token = await Promise.race([
            grecaptcha.execute("6LcR_okUAAAAAPYrPe-HK_0RULO1aZM15ENyM-Mf", { action: "homepage" }),
            new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 20000)),
        ]);
        out.exec = { len: token.length, prefix: token.slice(0, 20), ms: Date.now() - t0 };
    } catch (e) {
        out.exec = { err: String(e), ms: Date.now() - t0 };
    }
    return out;
})()
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
    await page.goto(TARGET, { waitUntil: "load", timeout: 90000 });
    const r = await page.evaluate(SCRIPT, { timeout: 90000 });
    console.log(JSON.stringify(r, null, 2));
    await browser.close();
    proc.kill("SIGTERM");
    process.exit(r?.exec?.len > 1000 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });