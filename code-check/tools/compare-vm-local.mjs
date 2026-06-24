#!/usr/bin/env node
// Deep VM/fingerprint compare: Velora vs Chrome (local about:blank).
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Browser } from "../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const OUT = resolve(repoRoot, "code-check/tmp/vm-compare");

const PROBE = `(async () => {
    const r = (fn, fb = null) => { try { return fn(); } catch (e) { return fb ?? String(e); } };
    const stackFmt = r(() => { try { null.x(); } catch (e) { return (e.stack || "").split("\\n").slice(0, 4); } });
    const stackLeak = r(() => { try { null.x(); } catch (e) { return /devtools|cdp|puppeteer|playwright/i.test(e.stack||""); } }, false);
    const errName = r(() => { try { null.x(); } catch (e) { return e.name; } });
    const chromeKeys = window.chrome ? Object.keys(window.chrome).sort() : [];
    const webgl = r(() => {
        const gl = document.createElement("canvas").getContext("webgl");
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        return {
            vendor: gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL),
            renderer: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL),
            version: gl.getParameter(gl.VERSION),
        };
    });
    const audio = await (async () => {
        const ctx = new OfflineAudioContext(1, 5000, 44100);
        const analyser = ctx.createAnalyser();
        const osc = ctx.createOscillator();
        osc.connect(analyser);
        analyser.connect(ctx.destination);
        osc.start(0);
        const buf = await ctx.startRendering();
        const d = buf.getChannelData(0);
        let s = 0; for (let i = 4500; i < d.length; i++) s += Math.abs(d[i]);
        return { tailSum: s, sample100: d[100] };
    })();
    const measureText = r(() => {
        const c = document.createElement("canvas");
        const ctx = c.getContext("2d");
        const fonts = ["Arial", "Helvetica Neue", "Times New Roman", "Courier New", "Georgia"];
        const texts = ["", "velora", "😀", "mmmmmmmmmmlli"];
        const out = [];
        for (const family of fonts) {
            ctx.font = '14px "' + family + '"';
            for (const text of texts) {
                const m = ctx.measureText(text);
                out.push([family, text, m.width, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent]);
            }
        }
        return out;
    });
    const voicesSync = speechSynthesis.getVoices().length;
    return {
        ua: navigator.userAgent,
        platform: navigator.platform,
        languages: [...navigator.languages],
        hw: navigator.hardwareConcurrency,
        mem: navigator.deviceMemory ?? null,
        webdriver: navigator.webdriver,
        chromeKeys,
        chromeRuntime: typeof window.chrome?.runtime,
        stackFmt,
        stackLeak,
        errName,
        webgl,
        measureText,
        voicesSync,
        perfTimeOrigin: performance.timeOrigin,
        hasIntl: typeof Intl !== "undefined",
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
        audio,
    };
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

async function capture(label, fn) {
    return { label, ...(await fn()) };
}

async function velora() {
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
        await page.goto("about:blank");
        await delay(500);
        return capture("velora", () => page.evaluate(PROBE));
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

async function chromeIncognito() {
    const browser = await chromium.launch({ channel: "chrome", headless: false, args: ["--incognito"] });
    try {
        const page = await browser.newPage();
        await page.goto("about:blank");
        await delay(500);
        return capture("chrome", () => page.evaluate(PROBE));
    } finally {
        await browser.close();
    }
}

function diff(a, b, path = "") {
    const out = [];
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
        const p = path ? `${path}.${k}` : k;
        const va = a?.[k];
        const vb = b?.[k];
        if (va && vb && typeof va === "object" && typeof vb === "object" && !Array.isArray(va)) {
            out.push(...diff(va, vb, p));
        } else if (JSON.stringify(va) !== JSON.stringify(vb)) {
            out.push({ key: p, velora: va, chrome: vb });
        }
    }
    return out;
}

async function main() {
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    mkdirSync(OUT, { recursive: true });
    const v = await velora();
    const c = await chromeIncognito();
    const diffs = diff(v, c).filter((d) => d.key !== "label");
    writeFileSync(resolve(OUT, "compare.json"), JSON.stringify({ velora: v, chrome: c, diffs }, null, 2));
    console.log(`diffs: ${diffs.length}`);
    for (const d of diffs.slice(0, 30)) {
        const vv = JSON.stringify(d.velora)?.slice(0, 80);
        const cc = JSON.stringify(d.chrome)?.slice(0, 80);
        console.log(`${d.key}: v=${vv} c=${cc}`);
    }
    console.log(`saved: ${OUT}/compare.json`);
}

main().catch((e) => { console.error(e); process.exit(2); });