#!/usr/bin/env node
// Hook fingerprint APIs on Google search to see what Google probes.
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const OUT = resolve(repoRoot, "code-check/tmp/google-fp-hook");
const SEARCH = "https://www.google.com/search?q=sgssprobe&hl=en";

const HOOK = `(() => {
    const store = window.top.__fpStore || (window.top.__fpStore = { log: [], url: location.href });
    const log = (type, detail) => {
        if (store.log.length < 500) store.log.push({ t: performance.now(), url: location.href.slice(0, 80), type, detail });
    };
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...a) {
        const w = this.width, h = this.height;
        log("toDataURL", { w, h, len: origToDataURL.apply(this, a).length });
        return origToDataURL.apply(this, a);
    };
    const origMeasure = CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText = function(text) {
        log("measureText", { font: this.font?.slice(0, 60), text: String(text).slice(0, 20) });
        return origMeasure.apply(this, arguments);
    };
    const origGetVoices = speechSynthesis.getVoices.bind(speechSynthesis);
    speechSynthesis.getVoices = function() {
        const v = origGetVoices();
        log("getVoices", { count: v.length });
        return v;
    };
    log("hook", { ua: navigator.userAgent.slice(0, 60) });
})()`;

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

    const browser = await Browser.connect(endpoint);
    try {
        const page = await browser.newPage();
        const cdp = page.session;
        await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK });
        await cdp.send("Network.enable");
        const snapshots = [];
        cdp.on("Network.responseReceived", async (p) => {
            const url = p.response?.url || "";
            if (!/google\.com/.test(url)) return;
            await delay(100);
            try {
                const snap = await page.evaluate(`({
                    href: location.href.slice(0, 120),
                    logLen: (window.top.__fpStore && window.top.__fpStore.log.length) || 0,
                    last: (window.top.__fpStore && window.top.__fpStore.log.slice(-5)) || [],
                })`);
                snapshots.push({ at: url.slice(0, 120), ...snap });
            } catch {}
        });
        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await delay(3000);
        const result = await page.evaluate(`({
            url: location.href,
            sorry: location.href.includes("/sorry"),
            log: (window.top.__fpStore && window.top.__fpStore.log) || [],
        })`);
        writeFileSync(resolve(OUT, "hook-log.json"), JSON.stringify({ ...result, snapshots }, null, 2));
        console.log(`url: ${result.url.slice(0, 100)}`);
        console.log(`sorry: ${result.sorry}`);
        console.log(`events: ${result.log.length}`);
        const types = {};
        for (const e of result.log) types[e.type] = (types[e.type] || 0) + 1;
        console.log("types:", types);
        for (const e of result.log.filter((x) => x.type === "toDataURL").slice(0, 15)) {
            console.log(`  canvas ${e.detail.w}x${e.detail.h} len=${e.detail.len}`);
        }
        for (const e of result.log.filter((x) => x.type === "measureText").slice(0, 10)) {
            console.log(`  measureText "${e.detail.text}" font=${e.detail.font}`);
        }
        console.log(`saved: ${OUT}/hook-log.json`);
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

main().catch((e) => { console.error(e); process.exit(2); });