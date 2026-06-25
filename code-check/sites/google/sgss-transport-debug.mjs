#!/usr/bin/env node
/**
 * Debug sg_ss transport delta: native vs chrome-transport vs real Chrome sidecar.
 * Output: code-check/tmp/google-sgss-debug/report.json
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
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const curlBin = resolve(repoRoot, "vendor/curl-impersonate/curl_chrome146");
const OUT = resolve(repoRoot, "code-check/tmp/google-sgss-debug");
const QUERY = process.argv[2] || `sgss-dbg-${Date.now()}`;
const SEARCH = `https://www.google.com/search?q=${encodeURIComponent(QUERY)}&hl=en`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
                : /sorry/i.test(h) ? "sorry" : "other",
    };
}

function hdrList(h) {
    const out = [];
    if (!h) return out;
    if (Array.isArray(h)) {
        for (const x of h) out.push({ name: x.name, value: x.value });
        return out;
    }
    for (const [k, v] of Object.entries(h)) out.push({ name: k, value: String(v) });
    return out;
}

function pickHeaders(headers, keys) {
    const m = {};
    for (const h of headers) m[h.name.toLowerCase()] = h.value;
    const out = {};
    for (const k of keys) if (m[k] != null) out[k] = m[k];
    return out;
}

const TRACK = [
    "user-agent", "accept", "accept-encoding", "accept-language", "referer", "cookie",
    "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user",
    "sec-ch-ua", "priority", "upgrade-insecure-requests",
];

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

async function runChromeSidecarAudit() {
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
            const headers = hdrList(p.request?.headers);
            events.push({
                phase: "request",
                kind: hopKind(url),
                url: url.slice(0, 240),
                headerOrder: headers.map((h) => h.name),
                headers: pickHeaders(headers, TRACK),
                allHeaders: headers,
            });
        });
        cdp.on("Network.responseReceived", (p) => {
            if (p.type !== "Document") return;
            const url = p.response?.url || "";
            if (!url.includes("google.com")) return;
            events.push({
                phase: "response",
                kind: hopKind(url),
                url: url.slice(0, 240),
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

        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
        for (let i = 0; i < 60; i++) {
            const u = page.url();
            if (u.includes("sg_ss=") || u.includes("/sorry") || /SearchResultsPage/.test(await page.content())) break;
            await delay(150);
        }
        await delay(1000);

        const finalUrl = page.url();
        const dom = classify(await page.content());
        for (const e of events) {
            if (e.phase !== "response" || !e.requestId) continue;
            const b = bodies.get(e.requestId);
            if (b) e.bodyClass = b;
        }
        return { mode: "chrome-sidecar", query: QUERY, search: SEARCH, events, finalUrl, dom };
    } finally {
        await browser.close();
    }
}

async function runVeloraMode(chromeTransport) {
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

    const events = [];
    const browser = await Browser.connect(endpoint);
    try {
        const page = await browser.newPage();
        const cdp = page.session;
        await cdp.send("Network.enable");

        cdp.on("Network.requestWillBeSent", (p) => {
            if (p.type !== "Document") return;
            const url = p.request?.url || "";
            if (!url.includes("google.com")) return;
            const headers = hdrList(p.request?.headers);
            events.push({
                phase: "request",
                kind: hopKind(url),
                url: url.slice(0, 240),
                headerOrder: headers.map((h) => h.name.toLowerCase()),
                headers: pickHeaders(headers, TRACK),
            });
        });
        cdp.on("Network.responseReceived", async (p) => {
            if (p.type !== "Document" || !p.response?.url?.includes("google.com")) return;
            const entry = {
                phase: "response",
                kind: hopKind(p.response.url),
                url: p.response.url.slice(0, 240),
                status: p.response?.status,
                protocol: p.response?.protocol,
                requestId: p.requestId,
            };
            events.push(entry);
            for (let i = 0; i < 25; i++) {
                try {
                    const body = await cdp.send("Network.getResponseBody", { requestId: p.requestId });
                    const html = body.base64Encoded
                        ? Buffer.from(body.body, "base64").toString("utf8")
                        : body.body;
                    entry.bodyClass = classify(html);
                    break;
                } catch {
                    await delay(50);
                }
            }
        });

        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
        for (let i = 0; i < 60; i++) {
            try {
                const u = await page.evaluate(() => location.href);
                if (u.includes("sg_ss=") || u.includes("/sorry")) break;
                if (/SearchResultsPage/.test(await page.content().catch(() => ""))) break;
            } catch {}
            await delay(150);
        }
        await delay(1500);

        let finalUrl = SEARCH;
        try { finalUrl = await page.evaluate(() => location.href); } catch {}
        const dom = classify(await page.content().catch(() => ""));
        return {
            mode: chromeTransport ? "velora-chrome-transport" : "velora-native",
            query: QUERY,
            search: SEARCH,
            events,
            finalUrl: finalUrl.slice(0, 240),
            dom,
            serpOk: dom.page === "SERP",
            blockedSorry: finalUrl.includes("/sorry") || dom.page === "sorry",
        };
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

async function curlGetSgss(url, cookie) {
    return new Promise((res) => {
        const args = ["-sS", "-w", "\n__META__%{http_code} %{url_effective}", "-D", "-"];
        if (cookie) args.push("-H", `Cookie: ${cookie}`);
        args.push(url);
        const proc = spawn(curlBin, args, { cwd: repoRoot });
        let stdout = "";
        proc.stdout.on("data", (d) => { stdout += d; });
        proc.on("close", () => {
            const parts = stdout.split("\n__META__");
            const raw = parts[0] || "";
            const meta = (parts[1] || "").trim().split(/\s+/);
            const status = Number(meta[0]) || 0;
            const hdrEnd = raw.indexOf("\r\n\r\n");
            const hdrText = hdrEnd >= 0 ? raw.slice(0, hdrEnd) : "";
            const body = hdrEnd >= 0 ? raw.slice(hdrEnd + 4) : raw;
            res({
                status,
                finalUrl: meta.slice(1).join(" ") || url,
                dom: classify(body),
                responseHeaders: hdrText.split("\r\n").slice(1, 15),
            });
        });
    });
}

function diffHops(a, b) {
    const diffs = [];
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i += 1) {
        const x = a[i];
        const y = b[i];
        if (!x || !y) {
            diffs.push({ index: i, note: !x ? "missing in A" : "missing in B" });
            continue;
        }
        const row = { index: i, kindA: x.kind, kindB: y.kind };
        if (x.protocol !== y.protocol) row.protocol = { a: x.protocol, b: y.protocol };
        if (x.bodyClass?.page !== y.bodyClass?.page) row.body = { a: x.bodyClass?.page, b: y.bodyClass?.page };
        if (x.status !== y.status) row.status = { a: x.status, b: y.status };
        if (JSON.stringify(x.headers) !== JSON.stringify(y.headers)) row.headers = { a: x.headers, b: y.headers };
        if (Object.keys(row).length > 3) diffs.push(row);
    }
    return diffs;
}

async function main() {
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    mkdirSync(OUT, { recursive: true });

    const qBase = QUERY;
    console.log(`[sgss-debug] base=${qBase}`);
    console.log("[1/3] Real Chrome sidecar (Playwright goto)...");
    const chromeSidecar = await runChromeSidecarAudit();
    await delay(35_000);

    console.log("[2/3] Velora native omnibox...");
    const native = await runVeloraMode(false);
    const sgssUrl = native.events.find((e) => e.kind === "sg_ss" && e.phase === "request")?.url
        || native.finalUrl;
    await delay(35_000);

    console.log("[3/3] Velora chrome-transport omnibox...");
    const transport = await runVeloraMode(true);
    await delay(20_000);

    let curlSgss = null;
    if (sgssUrl?.includes("sg_ss=")) {
        console.log("[4/4] curl_chrome146 direct GET sg_ss URL...");
        curlSgss = await curlGetSgss(sgssUrl, null);
    }

    const chromeHops = chromeSidecar.events.filter((e) => e.phase === "response");
    const nativeHops = native.events.filter((e) => e.phase === "response");
    const transportHops = transport.events.filter((e) => e.phase === "response");

    const report = {
        query: QUERY,
        search: SEARCH,
        chromeSidecar: { ...chromeSidecar, hopSummary: chromeHops.map(summarizeHop) },
        native: { ...native, hopSummary: nativeHops.map(summarizeHop) },
        transport: { ...transport, hopSummary: transportHops.map(summarizeHop) },
        curlSgss,
        analysis: {
            nativeFailHop: nativeHops.find((h) => h.kind === "sorry" || h.status === 429)?.kind || null,
            transportSkipsSgss: !transportHops.some((h) => h.kind === "sg_ss"),
            chromeSidecarSkipsSgss: !chromeHops.some((h) => h.kind === "sg_ss"),
            nativeVsChromeHop1: diffHops(nativeHops, chromeHops),
            sgssRequestHeaders: native.events.find((e) => e.kind === "sg_ss" && e.phase === "request") || null,
        },
    };

    writeFileSync(resolve(OUT, "report.json"), JSON.stringify(report, null, 2));

    console.log("\n=== Hop summary ===");
    console.log("Chrome sidecar:", report.chromeSidecar.hopSummary.map((h) => `${h.protocol} ${h.kind} ${h.body} ${h.status}`).join(" → "));
    console.log("Velora native: ", report.native.hopSummary.map((h) => `${h.protocol} ${h.kind} ${h.body} ${h.status}`).join(" → "));
    console.log("Chrome-transport:", report.transport.hopSummary.map((h) => `${h.protocol} ${h.kind} ${h.body} ${h.status}`).join(" → "));
    if (curlSgss) console.log("curl sg_ss:    ", curlSgss.status, curlSgss.dom.page);
    console.log(`\nnative serp=${native.serpOk} sorry=${native.blockedSorry}`);
    console.log(`transport serp=${transport.serpOk} sorry=${transport.blockedSorry}`);
    console.log(`saved: ${OUT}/report.json`);
}

function summarizeHop(h) {
    return {
        kind: h.kind,
        status: h.status,
        protocol: h.protocol,
        body: h.bodyClass?.page,
        bytes: h.bodyClass?.bytes,
        url: h.url?.slice(0, 100),
    };
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});