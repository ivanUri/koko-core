#!/usr/bin/env node
// Capture Google search page 1 HTML + inline probe before redirect.
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const OUT = resolve(repoRoot, "code-check/tmp/google-page1");
const SEARCH = "https://www.google.com/search?q=sgssprobe&hl=en";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const EARLY_PROBE = `(async () => {
    const r = (fn, fb = null) => { try { return fn(); } catch (e) { return fb ?? String(e); } };
    const canvas = r(() => {
        const c = document.createElement("canvas");
        c.width = 240; c.height = 60;
        const ctx = c.getContext("2d");
        ctx.font = "14px Arial";
        ctx.fillText("velora", 2, 2);
        return c.toDataURL().slice(-32);
    });
    const audio = await (async () => {
        const ctx = new OfflineAudioContext(1, 5000, 44100);
        const analyser = ctx.createAnalyser();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        const compressor = ctx.createDynamicsCompressor();
        oscillator.type = "triangle";
        oscillator.frequency.value = 10000;
        compressor.threshold.value = -50;
        gain.gain.value = 0.5;
        oscillator.connect(compressor);
        compressor.connect(analyser);
        analyser.connect(gain);
        gain.connect(ctx.destination);
        oscillator.start(0);
        const buffer = await ctx.startRendering();
        const data = buffer.getChannelData(0);
        let tailSum = 0;
        for (let i = 4500; i < data.length; i++) tailSum += Math.abs(data[i]);
        return { tailSum, sample100: data[100] };
    })();
    return {
        url: location.href,
        readyState: document.readyState,
        canvas,
        audio,
        webdriver: navigator.webdriver,
        languages: [...navigator.languages],
        screen: [screen.width, screen.height, innerWidth, innerHeight],
        chromeKeys: window.chrome ? Object.keys(window.chrome).sort() : [],
        csi: chrome.csi(),
        cookieLen: document.cookie.length,
        hasSgSs: document.cookie.includes("SG_SS"),
        scriptCount: document.scripts.length,
    };
})()`;

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

    const browser = await Browser.connect(endpoint);
    const captures = [];
    try {
        const page = await browser.newPage();
        const cdp = page.session;
        await cdp.send("Network.enable");

        let firstSearchBody = null;
        cdp.on("Network.responseReceived", async (p) => {
            const url = p.response?.url || "";
            if (url === SEARCH && p.response?.status === 200 && !firstSearchBody) {
                try {
                    const body = await cdp.send("Network.getResponseBody", { requestId: p.requestId });
                    firstSearchBody = (body.body || "").slice(0, 50000);
                } catch {}
            }
        });

        cdp.on("Network.requestWillBeSent", async (p) => {
            if (p.type !== "Document") return;
            const url = p.request?.url || "";
            if (!url.includes("google.com/search")) return;
            await delay(50);
            try {
                const probe = await page.evaluate(EARLY_PROBE);
                captures.push({ at: url.slice(0, 120), probe });
            } catch {}
        });

        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await delay(500);
        let finalProbe = null;
        try { finalProbe = await page.evaluate(EARLY_PROBE); } catch {}

        const report = { captures, finalProbe, htmlSnippet: firstSearchBody?.slice(0, 5000) };
        writeFileSync(resolve(OUT, "page1.json"), JSON.stringify(report, null, 2));
        if (firstSearchBody) writeFileSync(resolve(OUT, "page1.html"), firstSearchBody.slice(0, 200000));
        console.log(`captures: ${captures.length}`);
        for (const c of captures) {
            console.log(`  ${c.at} sgss=${c.probe.hasSgSs} cookieLen=${c.probe.cookieLen} scripts=${c.probe.scriptCount}`);
        }
        if (finalProbe) console.log(`final: ${finalProbe.url.slice(0, 80)} sgss=${finalProbe.hasSgSs}`);
        console.log(`saved: ${OUT}/`);
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

main().catch((e) => { console.error(e); process.exit(2); });