#!/usr/bin/env node
// Capture all Google network requests during search flow.
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const OUT = resolve(repoRoot, "code-check/tmp/google-net");
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
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    mkdirSync(OUT, { recursive: true });
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
    const events = [];
    const browser = await Browser.connect(endpoint);
    try {
        const page = await browser.newPage();
        const cdp = page.session;
        await cdp.send("Network.enable");
        cdp.on("Network.requestWillBeSent", (p) => {
            const url = p.request?.url || "";
            if (!/google\.com|gstatic\.com|googleusercontent/.test(url)) return;
            events.push({
                phase: "req",
                type: p.type,
                method: p.request?.method,
                url: url.slice(0, 200),
                postLen: p.request?.postData?.length ?? 0,
            });
        });
        cdp.on("Network.responseReceived", (p) => {
            const url = p.response?.url || "";
            if (!/google\.com|gstatic\.com/.test(url)) return;
            const setCookie = p.response?.headers?.["set-cookie"] || p.response?.headers?.["Set-Cookie"] || "";
            events.push({
                phase: "res",
                status: p.response?.status,
                url: url.slice(0, 200),
                hasSgSs: String(setCookie).includes("SG_SS"),
            });
        });
        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await delay(2500);
        const final = await page.evaluate(`({ url: location.href, sorry: location.href.includes("/sorry") })`);
        const report = { final, events };
        writeFileSync(resolve(OUT, "net.json"), JSON.stringify(report, null, 2));
        console.log(`final: ${final.url.slice(0, 90)} sorry=${final.sorry}`);
        console.log(`events: ${events.length}`);
        for (const e of events.filter((x) => x.phase === "res" && x.hasSgSs)) {
            console.log(`  SG_SS set on: ${e.url.slice(0, 100)} status=${e.status}`);
        }
        for (const e of events.filter((x) => x.postLen > 0).slice(0, 10)) {
            console.log(`  POST ${e.method} ${e.url.slice(0, 80)} body=${e.postLen}`);
        }
        console.log(`saved: ${OUT}/net.json`);
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

main().catch((e) => { console.error(e); process.exit(2); });