#!/usr/bin/env node
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
    mkdirSync(OUT, { recursive: true });
    const port = await getFreePort();
    // lldb detach keeps velora alive after probe exits
    const proc = spawn("lldb", [
        "-b",
        "-o", `run serve --host 127.0.0.1 --port ${port} --browser-profile chrome-macos-sonoma --log-level info`,
        "-o", "process detach",
        "-o", "quit",
        veloraBin,
    ], { cwd: repoRoot, stdio: "ignore" });

    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {}
        await delay(100);
    }

    const logs = [];
    const netEvents = [];
    const browser = await Browser.connect(endpoint);
    try {
        const page = await browser.newPage();
        const cdp = page.session;
        await cdp.send("Runtime.enable");
        await cdp.send("Log.enable");
        await cdp.send("Network.enable");

        cdp.on("Runtime.consoleAPICalled", (p) => {
            const args = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
            logs.push({ t: Date.now(), type: p.type, text: args.slice(0, 300) });
        });
        cdp.on("Log.entryAdded", (p) => {
            logs.push({ t: Date.now(), type: "log", text: (p.entry?.text || "").slice(0, 300) });
        });
        cdp.on("Network.requestWillBeSent", (p) => {
            const url = p.request?.url || "";
            if (/challenge-platform|challenges\.cloudflare/.test(url)) {
                netEvents.push({
                    phase: "req",
                    type: p.type,
                    method: p.request?.method,
                    url: url.slice(0, 200),
                    cookieLen: (p.request?.headers?.Cookie || "").length,
                });
            }
        });
        cdp.on("Network.responseReceived", (p) => {
            const url = p.response?.url || "";
            if (/challenge-platform|challenges\.cloudflare|grok\.com/.test(url)) {
                const sc = p.response?.headers?.["set-cookie"] || p.response?.headers?.["Set-Cookie"] || "";
                netEvents.push({
                    phase: "res",
                    status: p.response?.status,
                    url: url.slice(0, 200),
                    hasCf: String(sc).includes("cf_clearance") || String(sc).includes("__cf_bm"),
                });
            }
        });

        await page.goto("https://grok.com/", { waitUntil: "domcontentloaded", timeout: 120_000 });

        // Hook message events in main frame after load
        await page.evaluate(`(() => {
            window.__msgLog = [];
            window.addEventListener("message", (e) => {
                let d = e.data;
                try { d = typeof d === "string" ? d.slice(0, 120) : JSON.stringify(d).slice(0, 120); } catch {}
                window.__msgLog.push({ origin: e.origin, data: d });
            });
        })()`);

        for (let i = 0; i < 20; i++) {
            await delay(2000);
            const snap = await page.evaluate(`({
                url: location.href,
                title: document.title,
                cookie: document.cookie.slice(0, 200),
                msgCount: (window.__msgLog || []).length,
                msgs: (window.__msgLog || []).slice(-5),
                iframes: [...document.querySelectorAll("iframe")].map(f => ({ src: (f.src||"").slice(0,100), id: f.id })),
            })`).catch(() => null);
            if (!snap) break;
            console.log(`[${i}] title=${snap.title} cookies=${snap.cookie.length} msgs=${snap.msgCount} iframes=${snap.iframes.length}`);
            if (snap.cookie.includes("cf_clearance")) break;
        }

        const report = { logs: logs.slice(-80), netEvents };
        writeFileSync(resolve(OUT, "debug-probe.json"), JSON.stringify(report, null, 2));
        console.log(`saved ${OUT}/debug-probe.json (${logs.length} console, ${netEvents.length} net)`);
        for (const e of netEvents.filter((x) => x.phase === "req" && x.url.includes("flow"))) {
            console.log(`  XHR/fetch: ${e.method} cookieLen=${e.cookieLen} ${e.url}`);
        }
        for (const l of logs.filter((x) => /Turnstile|NetworkError|NotSupported|undefined/.test(x.text || ""))) {
            console.log(`  console: ${l.text}`);
        }
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

main().catch((e) => { console.error(e); process.exit(2); });