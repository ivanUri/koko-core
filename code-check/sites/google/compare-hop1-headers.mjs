#!/usr/bin/env node
// Compare hop-1 document request headers: Velora vs Chrome vs curl_chrome146 reference.
import { spawn, execSync } from "node:child_process";
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
const OUT = resolve(repoRoot, "code-check/tmp/google-hop1");
const SEARCH = "https://www.google.com/search?q=sgssprobe&hl=en";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const TRACK_KEYS = [
    "host",
    "user-agent",
    "accept",
    "accept-language",
    "accept-encoding",
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "sec-ch-ua-arch",
    "sec-ch-ua-bitness",
    "sec-ch-ua-full-version",
    "sec-ch-ua-full-version-list",
    "sec-ch-ua-model",
    "sec-ch-ua-platform-version",
    "sec-ch-ua-wow64",
    "sec-ch-ua-form-factors",
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
    "sec-fetch-user",
    "upgrade-insecure-requests",
    "priority",
    "cookie",
    "referer",
];

function normalizeHeaders(raw) {
    const out = {};
    if (!raw) return out;
    if (Array.isArray(raw)) {
        for (const h of raw) out[h.name.toLowerCase()] = h.value;
        return out;
    }
    for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = v;
    return out;
}

function orderedKeys(headers) {
    if (Array.isArray(headers)) return headers.map((h) => h.name.toLowerCase());
    return Object.keys(headers).map((k) => k.toLowerCase());
}

function pick(headers, keys = TRACK_KEYS) {
    const out = {};
    for (const k of keys) {
        if (headers[k] != null) out[k] = headers[k];
    }
    return out;
}

function parseCurlVerbose(stderr) {
    const lines = stderr.split("\n");
    const req = {};
    const order = [];
    let inReq = false;
    for (const line of lines) {
        if (line.startsWith("> GET ")) {
            inReq = true;
            continue;
        }
        if (inReq && line.startsWith("> ")) {
            const body = line.slice(2).trim();
            if (!body) continue;
            const idx = body.indexOf(":");
            if (idx <= 0) continue;
            const key = body.slice(0, idx).trim().toLowerCase();
            const val = body.slice(idx + 1).trim();
            req[key] = val;
            order.push(key);
            continue;
        }
        if (inReq && line.startsWith("< HTTP")) break;
    }
    return { headers: req, order };
}

function parseSetCookies(stderr) {
    const cookies = [];
    for (const line of stderr.split("\n")) {
        if (!line.startsWith("< set-cookie:")) continue;
        const val = line.slice("< set-cookie:".length).trim();
        const name = val.split("=")[0];
        cookies.push({ name, hasSgSs: name === "SG_SS" });
    }
    return cookies;
}

function diffHeaders(a, b, labelA, labelB) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const diffs = [];
    for (const k of [...keys].sort()) {
        const va = a[k];
        const vb = b[k];
        if (va === vb) continue;
        if (va == null) diffs.push({ key: k, only: labelB, value: vb });
        else if (vb == null) diffs.push({ key: k, only: labelA, value: va });
        else diffs.push({ key: k, [labelA]: va, [labelB]: vb });
    }
    return diffs;
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

async function captureCdp(label, getPageAndSession) {
    const docs = [];
    const responses = [];
    const { page, session, cleanup } = await getPageAndSession();
    try {
        await session.send("Network.enable");

        session.on("Network.requestWillBeSent", (p) => {
            if (p.type !== "Document") return;
            const url = p.request?.url || "";
            if (!url.includes("google.com/search")) return;
            if (url.includes("sei=")) return;
            if (docs.some((d) => d.url === url)) return;
            const h = normalizeHeaders(p.request?.headers);
            docs.push({
                label,
                url,
                headers: h,
                order: orderedKeys(p.request?.headers),
                picked: pick(h),
            });
        });

        session.on("Network.responseReceived", (p) => {
            const url = p.response?.url || "";
            if (!url.includes("google.com/search")) return;
            const setCookie = p.response?.headers?.["set-cookie"]
                ?? p.response?.headers?.["Set-Cookie"]
                ?? "";
            const sc = String(setCookie);
            responses.push({
                label,
                url: url.slice(0, 200),
                status: p.response?.status,
                hasSgSs: sc.includes("SG_SS"),
                setCookieNames: sc.split(/,(?=[^;]+?=)/).map((c) => c.trim().split("=")[0]).filter(Boolean),
            });
        });

        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await delay(1500);
        return { docs, responses };
    } finally {
        await cleanup().catch(() => {});
    }
}

async function captureVelora() {
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
    try {
        return await captureCdp("velora", async () => {
            const b = await Browser.connect(endpoint);
            const page = await b.newPage();
            return { page, session: page.session, cleanup: () => b.close() };
        });
    } finally {
        proc.kill("SIGTERM");
    }
}

async function captureChrome() {
    const browser = await chromium.launch({
        channel: "chrome",
        headless: false,
        args: ["--incognito", "--disable-blink-features=AutomationControlled"],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    return captureCdp("chrome", async () => ({
        page,
        session,
        cleanup: () => browser.close(),
    }));
}

function captureCurl() {
    const stderr = execSync(
        `"${curlBin}" -s -v "${SEARCH}" -o /dev/null 2>&1`,
        { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    const { headers, order } = parseCurlVerbose(stderr);
    const statusLine = stderr.match(/< HTTP\/[^\n]+/)?.[0] ?? "";
    const status = Number(statusLine.match(/\s(\d{3})\s/)?.[1] ?? 0);
    return {
        docs: [{
            label: "curl_chrome146",
            url: SEARCH,
            headers,
            order,
            picked: pick(headers),
        }],
        responses: [{
            label: "curl_chrome146",
            url: SEARCH,
            status,
            hasSgSs: parseSetCookies(stderr).some((c) => c.hasSgSs),
            setCookieNames: parseSetCookies(stderr).map((c) => c.name),
        }],
        stderrSnippet: stderr.split("\n").filter((l) => l.startsWith("> ") || l.startsWith("< HTTP") || l.startsWith("< set-cookie")).join("\n"),
    };
}

async function main() {
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    if (!existsSync(curlBin)) throw new Error("missing vendor/curl-impersonate/curl_chrome146");
    mkdirSync(OUT, { recursive: true });

    console.log("[1/3] curl_chrome146 reference...");
    const curl = captureCurl();

    console.log("[2/3] Chrome incognito hop-1...");
    const chrome = await captureChrome();

    console.log("[3/3] Velora hop-1...");
    const velora = await captureVelora();

    const curlDoc = curl.docs[0];
    const chromeDoc = chrome.docs[0];
    const veloraDoc = velora.docs[0];

    const veloraVsCurl = diffHeaders(veloraDoc?.picked ?? {}, curlDoc.picked, "velora", "curl");
    const veloraVsChrome = diffHeaders(veloraDoc?.picked ?? {}, chromeDoc?.picked ?? {}, "velora", "chrome");
    const chromeVsCurl = diffHeaders(chromeDoc?.picked ?? {}, curlDoc.picked, "chrome", "curl");

    const report = {
        search: SEARCH,
        hop1: {
            curl: curlDoc,
            chrome: chromeDoc,
            velora: veloraDoc,
        },
        hop1Responses: {
            curl: curl.responses[0],
            chrome: chrome.responses.find((r) => !r.url.includes("sei=")) ?? chrome.responses[0],
            velora: velora.responses.find((r) => !r.url.includes("sei=")) ?? velora.responses[0],
        },
        headerOrder: {
            curl: curlDoc.order,
            chrome: chromeDoc?.order ?? [],
            velora: veloraDoc?.order ?? [],
        },
        diffs: {
            veloraVsCurl,
            veloraVsChrome,
            chromeVsCurl,
        },
        curlTrace: curl.stderrSnippet,
    };

    writeFileSync(resolve(OUT, "hop1-headers.json"), JSON.stringify(report, null, 2));

    console.log("\n=== Hop-1 response (SG_SS trigger?) ===");
    for (const [k, v] of Object.entries(report.hop1Responses)) {
        if (!v) continue;
        console.log(`  ${k}: status=${v.status} SG_SS=${v.hasSgSs} cookies=${(v.setCookieNames || []).join(",")}`);
    }

    console.log("\n=== Velora vs curl_chrome146 (hop-1 request) ===");
    for (const d of veloraVsCurl.slice(0, 20)) {
        if (d.only) console.log(`  ${d.key}: only ${d.only} = ${String(d.value).slice(0, 100)}`);
        else console.log(`  ${d.key}:`);
        if (d.velora != null) console.log(`    velora: ${String(d.velora).slice(0, 120)}`);
        if (d.curl != null) console.log(`    curl:   ${String(d.curl).slice(0, 120)}`);
    }
    if (veloraVsCurl.length > 20) console.log(`  ... +${veloraVsCurl.length - 20} more`);

    console.log("\n=== Velora vs Chrome (hop-1 request) ===");
    for (const d of veloraVsChrome.slice(0, 15)) {
        if (d.only) console.log(`  ${d.key}: only ${d.only}`);
        else console.log(`  ${d.key}: velora≠chrome`);
    }

    console.log(`\nsaved: ${OUT}/hop1-headers.json`);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});