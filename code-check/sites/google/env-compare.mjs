#!/usr/bin/env node
// Compare Google search environment: Velora vs real Chrome (same machine, no proxy).
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const OUT = resolve(repoRoot, "code-check/tmp/env-audit");
const SEARCH = "https://www.google.com/search?q=velora&hl=en";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const DEEP_PROBE = `(() => {
    const r = (fn, fb = null) => { try { return fn(); } catch (e) { return fb ?? String(e); } };
    const nav = navigator;
    const chromeObj = window.chrome;
    const canvas = r(() => {
        const c = document.createElement("canvas");
        c.width = 240; c.height = 60;
        const ctx = c.getContext("2d");
        ctx.font = "14px Arial";
        ctx.fillText("velora", 2, 2);
        return c.toDataURL().slice(-32);
    });
    const webgl = r(() => {
        const gl = document.createElement("canvas").getContext("webgl");
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        return {
            vendor: gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL),
            renderer: gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL),
        };
    });
    return {
        url: location.href,
        sorry: location.href.includes("/sorry"),
        hasSei: location.href.includes("sei="),
        hasSgSs: location.href.includes("sg_ss="),
        hits: document.querySelectorAll("#search .g h3, .MjjYud h3").length,
        webdriver: nav.webdriver,
        ua: nav.userAgent,
        platform: nav.platform,
        languages: [...(nav.languages || [])],
        hardwareConcurrency: nav.hardwareConcurrency,
        deviceMemory: nav.deviceMemory ?? null,
        plugins: nav.plugins ? [...nav.plugins].map((p) => p.name) : [],
        chromeKeys: chromeObj ? Object.keys(chromeObj).sort() : [],
        chromeRuntime: typeof chromeObj?.runtime,
        screen: [screen.width, screen.height, devicePixelRatio],
        window: [outerWidth, outerHeight, innerWidth, innerHeight],
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        canvasTail: canvas,
        webgl,
        stackLeak: r(() => { try { null.x(); } catch (e) { return /devtools|cdp|puppeteer|playwright/i.test(e.stack||""); } }, false),
    };
})()`;

async function getFreePort() {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.unref();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
    });
}

async function captureDocs(page, onDoc) {
    page.on("request", (req) => {
        if (req.resourceType() !== "document") return;
        const url = req.url();
        if (!/google\.com/.test(url)) return;
        onDoc({
            url: url.slice(0, 200),
            hasSei: url.includes("sei="),
            hasSgSs: url.includes("sg_ss="),
            sorry: url.includes("/sorry"),
        });
    });
}

async function auditVelora() {
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
    const docs = [];
    const browser = await Browser.connect(endpoint);
    try {
        const page = await browser.newPage();
        const cdp = page.session;
        await cdp.send("Network.enable");
        cdp.on("Network.requestWillBeSent", (p) => {
            if (p.type !== "Document") return;
            const url = p.request?.url || "";
            if (!/google\.com/.test(url)) return;
            docs.push({
                url: url.slice(0, 200),
                hasSei: url.includes("sei="),
                hasSgSs: url.includes("sg_ss="),
                sorry: url.includes("/sorry"),
            });
        });
        const t0 = Date.now();
        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await delay(2500);
        const probe = await page.evaluate(DEEP_PROBE);
        return { label: "velora", ms: Date.now() - t0, probe, docs };
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

async function auditChrome() {
    const docs = [];
    const browser = await chromium.launch({
        channel: "chrome",
        headless: false,
        args: ["--incognito", "--disable-blink-features=AutomationControlled"],
    });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await captureDocs(page, (d) => docs.push(d));
        const t0 = Date.now();
        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await delay(2500);
        const probe = await page.evaluate(DEEP_PROBE);
        return { label: "chrome-incognito", ms: Date.now() - t0, probe, docs };
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

    console.log("Comparing Velora vs Chrome incognito (same machine)...\n");
    const velora = await auditVelora();
    const chrome = await auditChrome();
    const diffs = diff(velora.probe, chrome.probe);

    const report = { search: SEARCH, velora, chrome, diffs };
    writeFileSync(resolve(OUT, "compare.json"), JSON.stringify(report, null, 2));

    const print = (r) => {
        console.log(`[${r.label}] ${r.ms}ms`);
        console.log(`  final: ${r.probe.url.slice(0, 100)}`);
        console.log(`  sorry=${r.probe.sorry} sei=${r.probe.hasSei} sg_ss=${r.probe.hasSgSs} hits=${r.probe.hits}`);
        console.log(`  doc requests: ${r.docs.length}`);
        for (const d of r.docs) {
            const tag = d.sorry ? "SORRY" : d.hasSgSs ? "sg_ss" : d.hasSei ? "sei" : "search";
            console.log(`    ${tag}: ${d.url.slice(0, 95)}`);
        }
    };
    print(velora);
    console.log();
    print(chrome);

    console.log("\n=== Key finding ===");
    const vBot = velora.docs.length > 1 || velora.probe.sorry;
    const cBot = chrome.docs.length > 1 || chrome.probe.sorry;
    if (vBot && !cBot) {
        console.log("Velora triggers extra document navigation / sorry; Chrome does not.");
        console.log("→ Google bot-scoring rejects Velora JS environment on FIRST paint, not IP.");
    } else if (vBot && cBot) {
        console.log("Both trigger bot flow (unexpected for Chrome incognito).");
    } else {
        console.log("Neither blocked (rare).");
    }

    console.log("\n=== JS diffs (top 20) ===");
    for (const d of diffs.slice(0, 20)) {
        console.log(`${d.key}: velora=${JSON.stringify(d.velora)?.slice(0, 80)} chrome=${JSON.stringify(d.chrome)?.slice(0, 80)}`);
    }
    console.log(`\nsaved: ${OUT}/compare.json`);
}

main().catch((e) => { console.error(e); process.exit(2); });