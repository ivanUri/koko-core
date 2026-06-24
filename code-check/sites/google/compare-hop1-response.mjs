#!/usr/bin/env node
// Diff hop-1 document RESPONSE: body class, headers, HTTP version — Velora vs Chrome vs curl.
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
const OUT = resolve(repoRoot, "code-check/tmp/google-hop1-response");
const GOOGLE_HOME = "https://www.google.com/";
const QUERY = process.env.GOOGLE_QUERY || "coingloo.com";
const SEARCH = `https://www.google.com/search?q=${encodeURIComponent(QUERY)}`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const RESPONSE_HEADER_KEYS = [
    "content-type",
    "content-encoding",
    "content-length",
    "cache-control",
    "accept-ch",
    "alt-svc",
    "strict-transport-security",
    "cross-origin-opener-policy",
    "permissions-policy",
    "content-security-policy",
    "set-cookie",
    "date",
    "expires",
    "server",
    "x-frame-options",
];

function normalizeHeaders(raw) {
    const out = {};
    if (!raw) return out;
    if (Array.isArray(raw)) {
        for (const h of raw) {
            const k = h.name.toLowerCase();
            out[k] = out[k] ? `${out[k]}, ${h.value}` : h.value;
        }
        return out;
    }
    for (const [k, v] of Object.entries(raw)) out[k.toLowerCase()] = String(v);
    return out;
}

function pick(headers, keys) {
    const out = {};
    for (const k of keys) if (headers[k] != null) out[k] = headers[k];
    return out;
}

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
        out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return out;
}

function parseSetCookieNames(raw) {
    const s = String(raw || "");
    if (!s) return [];
    return s.split(/,(?=[^;]+?=)/).map((p) => p.trim().split("=")[0]).filter(Boolean);
}

function classifyBody(html) {
    const h = String(html || "");
    return {
        bytes: Buffer.byteLength(h, "utf8"),
        chars: h.length,
        searchResultsPage: /SearchResultsPage/.test(h),
        enablejs: /enablejs/.test(h),
        windowSgs: /window\.sgs/.test(h),
        knitsail: /\bknitsail\b/.test(h),
        sgssLiteral: (h.match(/SG_SS/g) || []).length,
        title: (h.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.slice(0, 80) ?? null,
        scriptTags: (h.match(/<script/gi) || []).length,
        hasSeiInBody: /[?&]sei=/.test(h),
        snippet: (() => {
            for (const pat of ["SearchResultsPage", "window.sgs", "enablejs", "knitsail"]) {
                const i = h.indexOf(pat);
                if (i >= 0) return h.slice(Math.max(0, i - 40), i + 120).replace(/\s+/g, " ");
            }
            return h.slice(0, 200).replace(/\s+/g, " ");
        })(),
    };
}

function diffObjects(a, b, keys) {
    const diffs = [];
    for (const k of keys) {
        const va = a[k];
        const vb = b[k];
        if (va === vb) continue;
        diffs.push({ key: k, a: va, b: vb });
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

function isHop1SearchUrl(url) {
    if (!url.includes("google.com/search")) return false;
    if (url.includes("sg_ss=")) return false;
    return true;
}

async function captureBrowserHop1(label, setup, { warmUp = false, omnibox = true } = {}) {
    const captures = [];
    const requestCookies = [];
    const { page, session, cleanup } = await setup();

    const fetchBody = async (meta) => {
        for (let i = 0; i < 30; i++) {
            try {
                const body = await session.send("Network.getResponseBody", { requestId: meta.requestId });
                const raw = body.body || "";
                const html = body.base64Encoded
                    ? Buffer.from(raw, "base64").toString("utf8")
                    : raw;
                return {
                    ...meta,
                    body: html,
                    bodyClass: classifyBody(html),
                    responsePicked: pick(meta.headers, RESPONSE_HEADER_KEYS),
                    setCookieNames: parseSetCookieNames(meta.headers["set-cookie"]),
                };
            } catch {
                await delay(50);
            }
        }
        return { ...meta, error: "getResponseBody timeout" };
    };

    try {
        await session.send("Network.enable");

        session.on("Network.requestWillBeSent", (p) => {
            if (p.type && p.type !== "Document") return;
            const url = p.request?.url || "";
            if (!isHop1SearchUrl(url) || url.includes("sei=")) return;
            const cookie = hdr(p.request?.headers, "cookie") || "";
            requestCookies.push({
                cookieLen: cookie.length,
                names: Object.keys(parseCookies(cookie)).sort(),
            });
        });

        session.on("Network.responseReceived", (p) => {
            if (p.type && p.type !== "Document") return;
            const url = p.response?.url || "";
            if (!isHop1SearchUrl(url)) return;
            const meta = {
                label,
                requestId: p.requestId,
                url,
                status: p.response?.status,
                protocol: p.response?.protocol ?? null,
                headers: normalizeHeaders(p.response?.headers),
                hasSei: url.includes("sei="),
            };
            void fetchBody(meta).then((c) => captures.push(c));
        });

        if (warmUp && !omnibox) {
            await page.goto(GOOGLE_HOME, { waitUntil: "domcontentloaded", timeout: 90_000 });
            await delay(1500);
        }

        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
        for (let i = 0; i < 50 && captures.length === 0; i++) await delay(100);

        // Prefer first document without sei= (true hop-1); else first search doc.
        const entry = captures.find((c) => !c.hasSei) ?? captures[0] ?? null;
        if (!entry) return null;
        const req = requestCookies[0];
        return {
            ...entry,
            requestCookieNames: req?.names ?? [],
            requestCookieLen: req?.cookieLen ?? 0,
            warmUp,
        };
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
        return await captureBrowserHop1("velora", async () => {
            const b = await Browser.connect(endpoint);
            const page = await b.newPage();
            return { page, session: page.session, cleanup: () => b.close() };
        }, { warmUp: false, omnibox: true });
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
    return captureBrowserHop1("chrome", async () => ({
        page,
        session,
        cleanup: () => browser.close(),
    }));
}

function captureCurl() {
    const bodyPath = resolve(OUT, "curl-hop1.body");
    const hdrPath = resolve(OUT, "curl-hop1.hdr");
    const stderr = execSync(
        `"${curlBin}" -s -v "${SEARCH}" -o "${bodyPath}" -D "${hdrPath}" 2>&1`,
        { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 },
    );
    const statusLine = stderr.match(/< HTTP\/([^\s]+)\s+(\d{3})/);
    const protocol = statusLine?.[1] ?? null;
    const status = Number(statusLine?.[2] ?? 0);
    const hdrText = execSync(`cat "${hdrPath}"`, { encoding: "utf8" });
    const headers = {};
    for (const line of hdrText.split("\n")) {
        const idx = line.indexOf(":");
        if (idx <= 0) continue;
        const k = line.slice(0, idx).trim().toLowerCase();
        const v = line.slice(idx + 1).trim();
        headers[k] = headers[k] ? `${headers[k]}, ${v}` : v;
    }
    const html = execSync(`cat "${bodyPath}"`, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
    return {
        label: "curl_chrome146",
        url: SEARCH,
        status,
        protocol,
        headers,
        body: html,
        bodyClass: classifyBody(html),
        responsePicked: pick(headers, RESPONSE_HEADER_KEYS),
        setCookieNames: parseSetCookieNames(headers["set-cookie"]),
        trace: stderr.split("\n").filter((l) =>
            l.startsWith("> ") || l.startsWith("< HTTP") || l.startsWith("< content-") || l.startsWith("< set-cookie"),
        ).join("\n"),
    };
}

function summarizeEntry(e) {
    if (!e) return null;
    const c = e.bodyClass || {};
    return {
        label: e.label,
        status: e.status,
        protocol: e.protocol,
        bytes: c.bytes,
        page: c.searchResultsPage ? "SERP" : c.enablejs || c.windowSgs ? "SGS" : "other",
        flags: {
            SearchResultsPage: c.searchResultsPage,
            enablejs: c.enablejs,
            windowSgs: c.windowSgs,
            knitsail: c.knitsail,
        },
        setCookieNames: e.setCookieNames,
        requestCookieNames: e.requestCookieNames,
        requestCookieLen: e.requestCookieLen,
        warmUp: e.warmUp ?? false,
        title: c.title,
    };
}

async function main() {
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    if (!existsSync(curlBin)) throw new Error("missing curl_chrome146");
    mkdirSync(OUT, { recursive: true });

    console.log("[1/3] curl_chrome146 hop-1 body...");
    const curl = captureCurl();

    console.log("[2/3] Chrome hop-1 body...");
    const chrome = await captureChrome();

    console.log("[3/3] Velora hop-1 body (guest omnibox, no warm-up)...");
    const velora = await captureVelora();

    for (const e of [curl, chrome, velora]) {
        if (e?.body) {
            writeFileSync(resolve(OUT, `${e.label}-hop1.html`), e.body.slice(0, 2_000_000));
        }
    }

    const report = {
        search: SEARCH,
        summary: {
            curl: summarizeEntry(curl),
            chrome: summarizeEntry(chrome),
            velora: summarizeEntry(velora),
        },
        responseHeaderDiffs: {
            veloraVsCurl: diffObjects(velora?.responsePicked ?? {}, curl.responsePicked, RESPONSE_HEADER_KEYS),
            veloraVsChrome: diffObjects(velora?.responsePicked ?? {}, chrome?.responsePicked ?? {}, RESPONSE_HEADER_KEYS),
            chromeVsCurl: diffObjects(chrome?.responsePicked ?? {}, curl.responsePicked, RESPONSE_HEADER_KEYS),
        },
        bodyClassDiffs: {
            veloraVsCurl: diffObjects(velora?.bodyClass ?? {}, curl.bodyClass, Object.keys(curl.bodyClass || {})),
            veloraVsChrome: diffObjects(velora?.bodyClass ?? {}, chrome?.bodyClass ?? {}, Object.keys(chrome?.bodyClass || {})),
        },
        entries: { curl, chrome, velora },
    };

    // Strip bodies from JSON report (saved as separate html files)
    for (const k of ["curl", "chrome", "velora"]) {
        if (report.entries[k]) {
            report.entries[k] = {
                ...report.entries[k],
                body: `[${report.entries[k].bodyClass?.bytes ?? 0} bytes → ${k}-hop1.html]`,
            };
        }
    }

    writeFileSync(resolve(OUT, "hop1-response.json"), JSON.stringify(report, null, 2));

    console.log("\n=== Hop-1 response summary ===");
    for (const [k, s] of Object.entries(report.summary)) {
        if (!s) { console.log(`  ${k}: (no capture)`); continue; }
        const sent = s.requestCookieNames?.length
            ? ` sent=[${s.requestCookieNames.join(",")}]`
            : "";
        console.log(
            `  ${k}: ${s.status} ${s.protocol ?? "?"} ${s.page} ${s.bytes}B${s.warmUp ? " warm" : ""}${sent} set=[${(s.setCookieNames || []).join(",")}]`,
        );
        console.log(`    flags: SERP=${s.flags.SearchResultsPage} enablejs=${s.flags.enablejs} sgs=${s.flags.windowSgs} knitsail=${s.flags.knitsail}`);
    }

    console.log("\n=== Velora vs curl (response headers) ===");
    for (const d of report.responseHeaderDiffs.veloraVsCurl.slice(0, 12)) {
        console.log(`  ${d.key}:`);
        console.log(`    velora: ${String(d.a ?? "(missing)").slice(0, 100)}`);
        console.log(`    curl:   ${String(d.b ?? "(missing)").slice(0, 100)}`);
    }

    console.log("\n=== Velora vs Chrome (body class) ===");
    for (const d of report.bodyClassDiffs.veloraVsChrome) {
        console.log(`  ${d.key}: velora=${d.a} chrome=${d.b}`);
    }

    console.log(`\nsaved: ${OUT}/hop1-response.json`);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});