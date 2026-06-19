#!/usr/bin/env node
// Deep diagnostic for reCAPTCHA v3 token generation in Velora.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
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

async function spawnVelora() {
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-catalina", "--log-level", "warn",
    ], { cwd: repoRoot, stdio: "ignore" });
    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch (_) {}
        await delay(100);
    }
    return { proc, endpoint };
}

const DIAG = `(async () => {
    const msgs = [];
    const orig = window.addEventListener.bind(window);
    window.addEventListener("message", (e) => {
        const d = e.data;
        let preview = "";
        try {
            if (typeof d === "string") preview = d.slice(0, 120);
            else preview = JSON.stringify(d)?.slice(0, 120) ?? String(d);
        } catch (_) { preview = String(d); }
        msgs.push({ origin: e.origin, preview, type: typeof d });
    }, true);

    await new Promise((r) => setTimeout(r, 8000));

    let cfg = null;
    try {
        const c = globalThis.___grecaptcha_cfg;
        if (c?.clients) {
            cfg = { clientKeys: Object.keys(c.clients), count: Object.keys(c.clients).length };
        }
    } catch (_) {}

    let token = null;
    let tokenErr = null;
    const t0 = Date.now();
    try {
        token = await grecaptcha.execute(${JSON.stringify(SITEKEY)}, { action: "homepage" });
    } catch (e) { tokenErr = String(e); }
    const execMs = Date.now() - t0;

    const iframes = [...document.querySelectorAll("iframe")].map((f) => ({
        src: (f.src || "").slice(0, 100),
        hidden: f.style?.display === "none" || f.hidden,
    }));

    return {
        msgs,
        cfg,
        tokenLen: token?.length ?? 0,
        tokenPrefix: token?.slice(0, 20) ?? null,
        tokenErr,
        execMs,
        iframes,
        workerSupported: typeof Worker !== "undefined",
    };
})()`;

async function main() {
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    const { proc, endpoint } = await spawnVelora();
    const browser = await Browser.connect(endpoint);
    const allReqs = [];

    try {
        const page = await browser.newPage();
        page.session.on("Network.requestWillBeSent", (p) => {
            const u = p.request?.url || "";
            if (/recaptcha|gstatic|google/i.test(u)) allReqs.push({ phase: "sent", url: u, method: p.request?.method });
        });
        page.session.on("Network.responseReceived", (p) => {
            const u = p.response?.url || "";
            if (/recaptcha|gstatic|google/i.test(u)) {
                allReqs.push({ phase: "recv", url: u, status: p.response?.status });
            }
        });

        await page.goto(TARGET, { waitUntil: "load", timeout: 90000 });
        const diag = await page.evaluate(DIAG, { timeout: 120000 });

        console.log("=== DIAG ===");
        console.log(JSON.stringify(diag, null, 2));
        console.log("\n=== NETWORK (recaptcha-related) ===");
        const seen = new Set();
        for (const r of allReqs) {
            const key = r.url + r.phase;
            if (seen.has(key)) continue;
            seen.add(key);
            const short = r.url.replace(/^https?:\/\//, "").slice(0, 120);
            console.log(`${r.phase} ${r.method || ""} ${r.status || ""} ${short}`);
        }
        const hasReload = allReqs.some((r) => /reload|userverify|clr/i.test(r.url));
        console.log(`\nhas reload/userverify/clr: ${hasReload}`);
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

main().catch((e) => { console.error(e); process.exit(1); });