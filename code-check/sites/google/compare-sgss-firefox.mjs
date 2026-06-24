#!/usr/bin/env node
// Compare SG_SS cookie: Velora (firefox-macos) vs real Firefox on Google search page 1.
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { firefox } from "playwright";
import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const OUT = resolve(repoRoot, "code-check/tmp/google-sgss-firefox");
const SEARCH = "https://www.google.com/search?q=sgssprobe&hl=en";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const VM_PROBE = `(async () => {
    const r = (fn, fb = null) => { try { return fn(); } catch (e) { return fb ?? String(e); } };
    const t = performance.timing;
    const canvas = r(() => {
        const c = document.createElement("canvas");
        c.width = 240; c.height = 60;
        const ctx = c.getContext("2d");
        ctx.font = "14px Arial";
        ctx.fillText("velora", 2, 2);
        return { tail: c.toDataURL().slice(-32), len: c.toDataURL().length };
    });
    return {
        url: location.href,
        readyState: document.readyState,
        perfNow: performance.now(),
        timeOrigin: performance.timeOrigin,
        timing: {
            navigationStart: t.navigationStart,
            domComplete: t.domComplete,
            loadEventEnd: t.loadEventEnd,
            span: t.loadEventEnd - t.navigationStart,
        },
        hasChrome: typeof chrome !== "undefined",
        canvas,
        voices: speechSynthesis.getVoices().length,
        webdriver: navigator.webdriver,
        vendor: navigator.vendor,
        product: navigator.product,
        plugins: navigator.plugins.length,
        languages: [...navigator.languages],
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory ?? null,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        docCookieLen: document.cookie.length,
        hasSgSsInDocCookie: document.cookie.includes("SG_SS="),
        audio: await (async () => {
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
            const freq = new Float32Array(analyser.frequencyBinCount);
            analyser.getFloatFrequencyData(freq);
            let freqSum = 0;
            for (const v of freq) freqSum += v;
            return { tailSum, freqSum, sample100: data[100] };
        })(),
    };
})()`;

function hdr(headers, key) {
    if (!headers) return null;
    const want = key.toLowerCase();
    if (Array.isArray(headers)) {
        const h = headers.find((x) => x.name?.toLowerCase() === want);
        return h?.value ?? null;
    }
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === want) return v;
    }
    return null;
}

function parseCookies(cookieHeader) {
    if (!cookieHeader) return {};
    const out = {};
    for (const part of cookieHeader.split(";")) {
        const idx = part.indexOf("=");
        if (idx <= 0) continue;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        out[k] = v;
    }
    return out;
}

function analyzeSgSs(value) {
    if (!value) return null;
    return {
        len: value.length,
        prefix: value.slice(0, 24),
        suffix: value.slice(-24),
        startsWithStar: value.startsWith("*"),
        segmentCount: value.split("_").length,
        hasWildcard: value.includes("*"),
    };
}

function diffKeys(a, b, path = "") {
    const out = [];
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
        const p = path ? `${path}.${k}` : k;
        const va = a?.[k];
        const vb = b?.[k];
        if (va && vb && typeof va === "object" && typeof vb === "object" && !Array.isArray(va)) {
            out.push(...diffKeys(va, vb, p));
        } else if (JSON.stringify(va) !== JSON.stringify(vb)) {
            out.push({ key: p, velora: va, firefox: vb });
        }
    }
    return out;
}

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

async function captureVelora() {
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "firefox-macos", "--log-level", "warn",
    ], { cwd: repoRoot, stdio: "ignore" });

    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i++) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {}
        await delay(100);
    }

    const docs = [];
    let seiCookieHeader = null;
    let seiStatus = null;

    const browser = await Browser.connect(endpoint);
    try {
        const page = await browser.newPage();
        const cdp = page.session;
        await cdp.send("Network.enable");

        cdp.on("Network.requestWillBeSent", (p) => {
            if (p.type !== "Document") return;
            const url = p.request?.url || "";
            if (!/google\.com/.test(url)) return;
            const entry = {
                atMs: Date.now(),
                url: url.slice(0, 200),
                hasSei: url.includes("sei="),
                cookieLen: (hdr(p.request?.headers, "cookie") || "").length,
            };
            docs.push(entry);
            if (url.includes("sei=")) {
                seiCookieHeader = hdr(p.request?.headers, "cookie");
            }
        });

        cdp.on("Network.responseReceived", (p) => {
            const url = p.response?.url || "";
            if (!/google\.com/.test(url)) return;
            if (url.includes("sei=") || url.includes("/sorry")) {
                seiStatus = p.response?.status;
            }
        });

        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await delay(2500);

        const probe = await page.evaluate(VM_PROBE);
        const cookies = parseCookies(seiCookieHeader);
        const sgss = cookies.SG_SS || null;

        return {
            label: "velora-firefox",
            probe,
            docs,
            seiStatus,
            cookies: {
                names: Object.keys(cookies).sort(),
                sgss: analyzeSgSs(sgss),
                sgssRaw: sgss,
                totalCookieHeaderLen: seiCookieHeader?.length ?? 0,
            },
        };
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

async function captureFirefox() {
    const docs = [];
    let seiCookieHeader = null;
    let seiStatus = null;

    const browser = await firefox.launch({
        headless: false,
        firefoxUserPrefs: {
            "privacy.resistFingerprinting": false,
            "dom.webdriver.enabled": false,
        },
    });

    try {
        const context = await browser.newContext();
        const page = await context.newPage();

        page.on("request", (request) => {
            if (request.resourceType() !== "document") return;
            const url = request.url();
            if (!/google\.com/.test(url)) return;
            const cookie = request.headers().cookie || "";
            docs.push({
                atMs: Date.now(),
                url: url.slice(0, 200),
                hasSei: url.includes("sei="),
                cookieLen: cookie.length,
            });
            if (url.includes("sei=")) {
                seiCookieHeader = cookie;
            }
        });

        page.on("response", (response) => {
            const url = response.url();
            if (!/google\.com/.test(url)) return;
            if (url.includes("sei=") || url.includes("/sorry")) {
                seiStatus = response.status();
            }
        });

        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await delay(2500);

        const probe = await page.evaluate(VM_PROBE);
        const cookies = parseCookies(seiCookieHeader);
        const sgss = cookies.SG_SS || null;

        return {
            label: "firefox",
            probe,
            docs,
            seiStatus,
            cookies: {
                names: Object.keys(cookies).sort(),
                sgss: analyzeSgSs(sgss),
                sgssRaw: sgss,
                totalCookieHeaderLen: seiCookieHeader?.length ?? 0,
            },
        };
    } finally {
        await browser.close();
    }
}

async function main() {
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    mkdirSync(OUT, { recursive: true });

    console.log("Capturing SG_SS from Firefox first (cleaner IP state)...\n");
    const ff = await captureFirefox();
    console.log("Waiting 8s before Velora capture...\n");
    await delay(8000);
    const velora = await captureVelora();

    const probeDiffs = diffKeys(velora.probe, ff.probe);
    const sgssLenDiff = (velora.cookies.sgss?.len ?? 0) - (ff.cookies.sgss?.len ?? 0);

    const report = {
        search: SEARCH,
        velora,
        firefox: ff,
        comparison: {
            seiStatus: { velora: velora.seiStatus, firefox: ff.seiStatus },
            sgssLenDiff,
            sgssPrefixMatch: velora.cookies.sgss?.prefix === ff.cookies.sgss?.prefix,
            cookieNamesOnlyVelora: velora.cookies.names.filter((n) => !ff.cookies.names.includes(n)),
            cookieNamesOnlyFirefox: ff.cookies.names.filter((n) => !velora.cookies.names.includes(n)),
            probeDiffs,
        },
    };

    writeFileSync(resolve(OUT, "compare-sgss-firefox.json"), JSON.stringify(report, null, 2));

    const line = (r) => {
        console.log(`[${r.label}] sei status=${r.seiStatus} docs=${r.docs.length}`);
        console.log(`  final: ${r.probe.url.slice(0, 100)}`);
        console.log(`  SG_SS len=${r.cookies.sgss?.len ?? 0} prefix=${r.cookies.sgss?.prefix ?? "(none)"}`);
        console.log(`  cookie header=${r.cookies.totalCookieHeaderLen} chars names=${r.cookies.names.join(",")}`);
        console.log(`  hasChrome=${r.probe.hasChrome} vendor=${JSON.stringify(r.probe.vendor)} plugins=${r.probe.plugins}`);
        console.log(`  canvas=${r.probe.canvas?.tail} voices=${r.probe.voices}`);
    };

    console.log("=== SG_SS compare (Firefox persona) ===\n");
    line(ff);
    console.log();
    line(velora);

    console.log("\n=== Probe diffs (top 15) ===");
    for (const d of probeDiffs.slice(0, 15)) {
        console.log(`${d.key}: velora=${JSON.stringify(d.velora)?.slice(0, 60)} firefox=${JSON.stringify(d.firefox)?.slice(0, 60)}`);
    }

    console.log("\n=== SG_SS structure ===");
    console.log(`len diff (velora-firefox): ${sgssLenDiff}`);
    console.log(`prefix match: ${report.comparison.sgssPrefixMatch}`);

    console.log(`\nsaved: ${OUT}/compare-sgss-firefox.json`);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});