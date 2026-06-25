#!/usr/bin/env node
/**
 * Root-cause debug matrix: Chrome ground-truth + Velora native vs chrome-transport.
 *
 * Usage:
 *   node code-check/sites/google/rc-matrix.mjs
 *   VELORA_BIN=/path/to/velora node code-check/sites/google/rc-matrix.mjs --baseline current
 *   node code-check/sites/google/rc-matrix.mjs --only chrome,omnibox-native
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const OUT_ROOT = resolve(repoRoot, "code-check/tmp/google-rc");
const DEFAULT_BIN = resolve(repoRoot, "zig-out/bin/velora");
const CURL_BIN = resolve(repoRoot, "vendor/curl-impersonate/curl_chrome146");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = {
        baseline: "current",
        veloraBin: process.env.VELORA_BIN || DEFAULT_BIN,
        only: null,
        cooldownMs: 35_000,
        query: `velora-rc-${Date.now()}`,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
            i += 1;
            return argv[i];
        };
        switch (a) {
            case "--baseline": out.baseline = next(); break;
            case "--bin": out.veloraBin = resolve(next()); break;
            case "--query": out.query = next(); break;
            case "--only": out.only = new Set(next().split(",")); break;
            case "--cooldown": out.cooldownMs = Number(next()); break;
            case "--help":
                console.log(`Usage: node rc-matrix.mjs [--baseline current|prefix] [--bin PATH] [--query Q] [--only chrome,omnibox-native,...]`);
                process.exit(0);
            default:
                if (!a.startsWith("--")) out.query = a;
        }
    }
    return out;
}

function hopKind(url) {
    if (url.includes("/sorry")) return "sorry";
    if (url.includes("sg_ss=")) return "sg_ss";
    if (url.includes("sei=")) return "sei";
    if (url.includes("google.com/search")) return "search";
    return "other";
}

function classify(html) {
    const h = String(html || "");
    return {
        bytes: Buffer.byteLength(h, "utf8"),
        page: /SearchResultsPage/.test(h) ? "SERP"
            : /window\.sgs/.test(h) ? "SGS"
                : /sorry/i.test(h) ? "sorry"
                    : "other",
    };
}

function hdrMap(h) {
    const out = {};
    if (!h) return out;
    if (Array.isArray(h)) {
        for (const x of h) out[x.name.toLowerCase()] = x.value;
        return out;
    }
    for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
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

async function runChromeOmnibox(query, outDir) {
    mkdirSync(outDir, { recursive: true });
    const search = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
    const events = [];
    const bodies = new Map();

    const browser = await chromium.launch({
        channel: "chrome",
        headless: true,
        args: ["--incognito", "--disable-blink-features=AutomationControlled"],
    });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");

        cdp.on("Network.requestWillBeSent", (p) => {
            if (p.type !== "Document") return;
            const url = p.request?.url || "";
            if (!url.includes("google.com")) return;
            events.push({
                phase: "request",
                kind: hopKind(url),
                url: url.slice(0, 200),
                headers: hdrMap(p.request?.headers),
            });
        });
        cdp.on("Network.responseReceived", (p) => {
            if (p.type !== "Document") return;
            const url = p.response?.url || "";
            if (!url.includes("google.com")) return;
            events.push({
                phase: "response",
                kind: hopKind(url),
                url: url.slice(0, 200),
                status: p.response?.status,
                protocol: p.response?.protocol,
                requestId: p.requestId,
            });
        });
        cdp.on("Network.loadingFinished", async (p) => {
            try {
                const res = await cdp.send("Network.getResponseBody", { requestId: p.requestId });
                const html = res.base64Encoded
                    ? Buffer.from(res.body, "base64").toString("utf8")
                    : res.body;
                bodies.set(p.requestId, classify(html));
            } catch {}
        });

        await page.goto(search, { waitUntil: "domcontentloaded", timeout: 90_000 });
        for (let i = 0; i < 50; i++) {
            const u = page.url();
            if (u.includes("sg_ss=") || u.includes("/sorry")) break;
            await delay(100);
        }
        await delay(800);

        const finalUrl = page.url();
        const dom = classify(await page.content());
        for (const e of events) {
            if (e.phase !== "response" || !e.requestId) continue;
            const b = bodies.get(e.requestId);
            if (b) e.bodyClass = b;
        }

        const report = {
            mode: "chrome",
            flow: "omnibox",
            query,
            search,
            finalUrl: finalUrl.slice(0, 240),
            dom,
            documentHops: events,
            serpOk: dom.page === "SERP",
            blockedSorry: finalUrl.includes("/sorry") || dom.page === "sorry",
            rateLimited: finalUrl.includes("/sorry") || dom.page === "sorry",
        };
        writeFileSync(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));
        return report;
    } finally {
        await browser.close();
    }
}

async function runCurlDirect(query, outDir) {
    mkdirSync(outDir, { recursive: true });
    const search = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
    return new Promise((res, rej) => {
        const proc = spawn(CURL_BIN, ["-sS", "-w", "\n__META__%{http_code} %{url_effective}", search], {
            cwd: repoRoot,
            env: { ...process.env },
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d) => { stdout += d; });
        proc.stderr.on("data", (d) => { stderr += d; });
        proc.on("close", (code) => {
            const parts = stdout.split("\n__META__");
            const body = parts[0] || "";
            const meta = (parts[1] || "").trim().split(/\s+/);
            const status = Number(meta[0]) || 0;
            const finalUrl = meta.slice(1).join(" ") || search;
            const dom = classify(body);
            const report = {
                mode: "curl",
                flow: "omnibox",
                query,
                search,
                exitCode: code,
                status,
                finalUrl: finalUrl.slice(0, 240),
                dom,
                serpOk: dom.page === "SERP",
                blockedSorry: finalUrl.includes("/sorry") || dom.page === "sorry",
                stderrTail: stderr.slice(-2000),
            };
            writeFileSync(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));
            if (code !== 0 && !body) rej(new Error(`curl exit ${code}`));
            else res(report);
        });
        proc.on("error", rej);
    });
}

async function runVeloraOmnibox({ veloraBin, query, chromeTransport, outDir }) {
    mkdirSync(outDir, { recursive: true });
    const search = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
    const port = await getFreePort();
    const serveArgs = [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-sonoma", "--log-level", "warn",
    ];
    if (chromeTransport) serveArgs.push("--google-chrome-transport");

    const proc = spawn(veloraBin, serveArgs, {
        cwd: repoRoot,
        stdio: "ignore",
        env: { ...process.env, VELORA_ROOT: repoRoot },
    });

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
            if (p.type !== "Document" || !p.request?.url?.includes("google.com")) return;
            const h = p.request.headers || {};
            docs.push({
                phase: "request",
                kind: hopKind(p.request.url),
                url: p.request.url.slice(0, 200),
                cookieLen: (h.Cookie || h.cookie || "").length,
                secFetchSite: h["sec-fetch-site"] || h["Sec-Fetch-Site"] || null,
                referer: h.Referer || h.referer || null,
                hasSecFetchUser: !!(h["sec-fetch-user"] || h["Sec-Fetch-User"]),
            });
        });
        cdp.on("Network.responseReceived", (p) => {
            if (p.type !== "Document" || !p.response?.url?.includes("google.com")) return;
            const idx = docs.findIndex((d) => d.phase === "request" && p.response.url.startsWith(d.url.slice(0, 80)));
            const entry = {
                phase: "response",
                kind: hopKind(p.response.url),
                url: p.response.url.slice(0, 200),
                status: p.response?.status,
                protocol: p.response?.protocol,
                requestId: p.requestId,
            };
            if (idx >= 0) Object.assign(docs[idx], entry);
            else docs.push(entry);
        });
        cdp.on("Network.loadingFinished", async (p) => {
            try {
                const body = await cdp.send("Network.getResponseBody", { requestId: p.requestId });
                const html = body.base64Encoded
                    ? Buffer.from(body.body, "base64").toString("utf8")
                    : body.body;
                const cls = classify(html);
                const doc = docs.find((d) => d.requestId === p.requestId);
                if (doc) doc.bodyClass = cls;
            } catch {}
        });

        await page.goto(search, { waitUntil: "domcontentloaded", timeout: 90_000 });
        let finalUrl = search;
        for (let i = 0; i < 50; i++) {
            try {
                finalUrl = await page.evaluate(() => location.href);
            } catch {
                try { finalUrl = await page.evaluate(() => document.URL); } catch {}
            }
            if (finalUrl.includes("sg_ss=") || finalUrl.includes("/sorry")) break;
            await delay(100);
        }
        await delay(1500);

        try {
            finalUrl = await page.evaluate(() => location.href);
        } catch {
            try { finalUrl = await page.evaluate(() => document.URL); } catch {}
        }
        const dom = classify(await page.content().catch(() => ""));
        const report = {
            mode: chromeTransport ? "chrome-transport" : "native",
            flow: "omnibox",
            query,
            search,
            docs,
            finalUrl: finalUrl.slice(0, 240),
            dom,
            serpOk: dom.page === "SERP",
            blockedSorry: finalUrl.includes("/sorry") || dom.page === "sorry",
        };
        writeFileSync(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));
        return report;
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

async function runVeloraHomepage({ veloraBin, query, chromeTransport, outDir }) {
    mkdirSync(outDir, { recursive: true });
    const port = await getFreePort();
    const serveArgs = [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-sonoma", "--log-level", "warn",
    ];
    if (chromeTransport) serveArgs.push("--google-chrome-transport");

    const proc = spawn(veloraBin, serveArgs, {
        cwd: repoRoot,
        stdio: "ignore",
        env: { ...process.env, VELORA_ROOT: repoRoot },
    });

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
            if (p.type !== "Document" || !p.request?.url?.includes("google.com")) return;
            const h = p.request.headers || {};
            docs.push({
                phase: "request",
                kind: hopKind(p.request.url),
                url: p.request.url.slice(0, 200),
                cookieLen: (h.Cookie || h.cookie || "").length,
                secFetchSite: h["sec-fetch-site"] || h["Sec-Fetch-Site"] || null,
                referer: h.Referer || h.referer || null,
                hasSecFetchUser: !!(h["sec-fetch-user"] || h["Sec-Fetch-User"]),
            });
        });
        cdp.on("Network.responseReceived", (p) => {
            if (p.type !== "Document" || !p.response?.url?.includes("google.com")) return;
            const entry = {
                phase: "response",
                kind: hopKind(p.response.url),
                url: p.response.url.slice(0, 200),
                status: p.response?.status,
                protocol: p.response?.protocol,
                requestId: p.requestId,
            };
            const doc = docs.find((d) => d.phase === "request" && !d.status && hopKind(p.response.url) === d.kind);
            if (doc) Object.assign(doc, entry);
            else docs.push(entry);
        });
        cdp.on("Network.loadingFinished", async (p) => {
            try {
                const body = await cdp.send("Network.getResponseBody", { requestId: p.requestId });
                const html = body.base64Encoded
                    ? Buffer.from(body.body, "base64").toString("utf8")
                    : body.body;
                const cls = classify(html);
                const doc = docs.find((d) => d.requestId === p.requestId);
                if (doc) doc.bodyClass = cls;
            } catch {}
        });

        await page.goto("https://www.google.com/?hl=en", { waitUntil: "domcontentloaded", timeout: 60_000 });
        await delay(1500);

        const inputSel = 'textarea[name="q"], input[name="q"]';
        await page.waitForSelector(inputSel, { timeout: 15_000 });
        await page.click(inputSel);
        await page.keyboard.type(query, { delay: 40 });
        await page.keyboard.press("Enter");
        await delay(100);

        let finalUrl = "https://www.google.com/?hl=en";
        for (let i = 0; i < 80; i++) {
            try {
                finalUrl = await page.evaluate(() => location.href);
            } catch {
                try { finalUrl = await page.evaluate(() => document.URL); } catch {}
            }
            if (finalUrl.includes("sg_ss=") || finalUrl.includes("/sorry")) break;
            if (finalUrl.includes("/search")) {
                const html = await page.content().catch(() => "");
                if (/SearchResultsPage/.test(html)) break;
            }
            await delay(200);
        }
        await delay(2000);

        try {
            finalUrl = await page.evaluate(() => location.href);
        } catch {
            try { finalUrl = await page.evaluate(() => document.URL); } catch {}
        }
        const dom = classify(await page.content().catch(() => ""));
        const report = {
            mode: chromeTransport ? "chrome-transport" : "native",
            flow: "homepage",
            query,
            docs,
            finalUrl: finalUrl.slice(0, 240),
            dom,
            serpOk: dom.page === "SERP",
            blockedSorry: finalUrl.includes("/sorry") || dom.page === "sorry",
        };
        writeFileSync(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));
        return report;
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

function shouldRun(only, key) {
    return !only || only.has(key);
}

function summarize(report) {
    const hops = (report.docs || report.documentHops || [])
        .filter((d) => d.phase === "response" || d.status)
        .map((d) => `${d.protocol ?? "?"} ${d.kind} ${d.bodyClass?.page ?? "?"}`);
    return {
        mode: report.mode,
        flow: report.flow,
        serpOk: report.serpOk,
        blockedSorry: report.blockedSorry,
        finalUrl: report.finalUrl,
        dom: report.dom?.page,
        hops: hops.join(" → ") || "(none)",
    };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!existsSync(opts.veloraBin)) throw new Error(`velora binary missing: ${opts.veloraBin}`);
    mkdirSync(OUT_ROOT, { recursive: true });

    const runId = `${opts.baseline}-${opts.query}`;
    const matrix = [];
    const steps = [];

    if (shouldRun(opts.only, "chrome")) steps.push(["chrome", () => runChromeOmnibox(opts.query, resolve(OUT_ROOT, `${runId}/chrome-omnibox`))]);
    if (shouldRun(opts.only, "curl")) steps.push(["curl", () => runCurlDirect(opts.query, resolve(OUT_ROOT, `${runId}/curl-omnibox`))]);
    if (shouldRun(opts.only, "omnibox-native")) steps.push(["omnibox-native", () => runVeloraOmnibox({ veloraBin: opts.veloraBin, query: opts.query, chromeTransport: false, outDir: resolve(OUT_ROOT, `${runId}/omnibox-native`) })]);
    if (shouldRun(opts.only, "omnibox-transport")) steps.push(["omnibox-transport", () => runVeloraOmnibox({ veloraBin: opts.veloraBin, query: opts.query, chromeTransport: true, outDir: resolve(OUT_ROOT, `${runId}/omnibox-transport`) })]);
    if (shouldRun(opts.only, "homepage-native")) steps.push(["homepage-native", () => runVeloraHomepage({ veloraBin: opts.veloraBin, query: opts.query, chromeTransport: false, outDir: resolve(OUT_ROOT, `${runId}/homepage-native`) })]);
    if (shouldRun(opts.only, "homepage-transport")) steps.push(["homepage-transport", () => runVeloraHomepage({ veloraBin: opts.veloraBin, query: opts.query, chromeTransport: true, outDir: resolve(OUT_ROOT, `${runId}/homepage-transport`) })]);

    console.log(`\n=== RC matrix: baseline=${opts.baseline} query=${opts.query} bin=${opts.veloraBin} ===\n`);

    for (let i = 0; i < steps.length; i += 1) {
        const [name, fn] = steps[i];
        console.log(`[${i + 1}/${steps.length}] ${name} ...`);
        try {
            const report = await fn();
            const row = { baseline: opts.baseline, ...summarize(report) };
            matrix.push(row);
            console.log(`  → serpOk=${row.serpOk} sorry=${row.blockedSorry} dom=${row.dom} hops=${row.hops}`);
            console.log(`  → final=${row.finalUrl}\n`);
        } catch (e) {
            matrix.push({ baseline: opts.baseline, mode: name, error: String(e) });
            console.error(`  → ERROR: ${e}\n`);
        }
        if (i < steps.length - 1) {
            console.log(`  cooldown ${opts.cooldownMs}ms ...`);
            await delay(opts.cooldownMs);
        }
    }

    const summaryPath = resolve(OUT_ROOT, `${runId}/matrix-summary.json`);
    writeFileSync(summaryPath, JSON.stringify({ runId, query: opts.query, baseline: opts.baseline, veloraBin: opts.veloraBin, matrix }, null, 2));
    console.log(`\n=== Matrix summary ===`);
    for (const row of matrix) {
        if (row.error) console.log(`${row.mode}: ERROR ${row.error}`);
        else console.log(`${row.mode} (${row.flow}): serpOk=${row.serpOk} sorry=${row.blockedSorry} dom=${row.dom}`);
    }
    console.log(`\nsaved: ${summaryPath}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});