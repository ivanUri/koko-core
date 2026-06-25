#!/usr/bin/env node
// Trace Cloudflare Turnstile → cf_clearance flow on grok.com.
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const OUT = resolve(repoRoot, "code-check/tmp/grok-cf");
const TARGET = "https://grok.com/";
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
    // lldb batch `run` blocks until exit; spawn in background like crash-repro.sh.
    const proc = spawn("lldb", [
        "-b",
        "-o", `run serve --host 127.0.0.1 --port ${port} --browser-profile chrome-macos-sonoma --log-level warn`,
        "-o", "process detach",
        "-o", "quit",
        veloraBin,
    ], { cwd: repoRoot, stdio: "ignore", detached: true });
    proc.unref();
    const endpoint = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 120; i++) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) { ready = true; break; } } catch {}
        await delay(250);
    }
    if (!ready) throw new Error(`velora not ready on ${endpoint}`);
    const events = [];
    const browser = await Browser.connect(endpoint);
    try {
        const page = await browser.newPage();
        const cdp = page.session;
        await cdp.send("Network.enable");
        cdp.on("Network.responseReceived", (p) => {
            const url = p.response?.url || "";
            if (!/grok\.com|challenges\.cloudflare\.com/.test(url)) return;
            const sc = p.response?.headers?.["set-cookie"] || p.response?.headers?.["Set-Cookie"] || "";
            events.push({
                phase: "res",
                status: p.response?.status,
                url: url.slice(0, 160),
                setCookie: String(sc).slice(0, 200),
                hasCfClearance: String(sc).includes("cf_clearance"),
            });
        });
        cdp.on("Network.requestWillBeSent", (p) => {
            const url = p.request?.url || "";
            if (!/grok\.com/.test(url) || p.type !== "Document") return;
            events.push({
                phase: "doc",
                method: p.request?.method,
                url: url.slice(0, 160),
                cookieLen: (p.request?.headers?.Cookie || p.request?.headers?.cookie || "").length,
            });
        });
        cdp.on("Network.requestWillBeSent", (p) => {
            const url = p.request?.url || "";
            if (!url.includes("challenge-platform/h/b/flow")) return;
            events.push({
                phase: "flow_req",
                method: p.request?.method,
                cookieLen: (p.request?.headers?.Cookie || "").length,
            });
        });

        await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 120_000 });
        for (let i = 0; i < 45; i++) {
            const snap = await page.evaluate(`({
                url: location.href,
                title: document.title,
                cookieLen: document.cookie.length,
                hasCfClearance: document.cookie.includes("cf_clearance"),
                body: (document.body?.innerText || "").slice(0, 200),
            })`);
            if (snap.hasCfClearance || (snap.url === TARGET && snap.title !== "Just a moment..." && !snap.body.includes("Waiting"))) break;
            await delay(2000);
        }
        const final = await page.evaluate(`({
            url: location.href,
            title: document.title,
            cookieLen: document.cookie.length,
            hasCfClearance: document.cookie.includes("cf_clearance"),
            body: (document.body?.innerText || "").slice(0, 300),
        })`);
        const report = { final, events };
        writeFileSync(resolve(OUT, "probe.json"), JSON.stringify(report, null, 2));
        console.log(`final url: ${final.url}`);
        console.log(`title: ${final.title}`);
        console.log(`document.cookie len=${final.cookieLen} cf_clearance=${final.hasCfClearance}`);
        console.log(`body: ${final.body.replace(/\n/g, " ").slice(0, 120)}`);
        console.log(`events: ${events.length}`);
        for (const e of events.filter((x) => x.hasCfClearance)) {
            console.log(`  cf_clearance Set-Cookie on: ${e.url} status=${e.status}`);
        }
        for (const e of events.filter((x) => x.phase === "doc")) {
            console.log(`  doc nav: ${e.method} cookieLen=${e.cookieLen} ${e.url}`);
        }
        for (const e of events.filter((x) => x.phase === "flow_req")) {
            console.log(`  flow XHR: ${e.method} cookieLen=${e.cookieLen}`);
        }
        console.log(`saved: ${OUT}/probe.json`);
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

main().catch((e) => { console.error(e); process.exit(2); });