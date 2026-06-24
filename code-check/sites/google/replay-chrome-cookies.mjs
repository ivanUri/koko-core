#!/usr/bin/env node
// Inject cookies captured from real Chrome, then measure Velora hop-1 search response.
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
const OUT = resolve(repoRoot, "code-check/tmp/google-cookie-replay");
const SEARCH = "https://www.google.com/search?q=sgssprobe&hl=en";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function classify(html) {
    const h = String(html || "");
    return {
        bytes: Buffer.byteLength(h, "utf8"),
        page: /SearchResultsPage/.test(h) ? "SERP" : /window\.sgs/.test(h) ? "SGS" : "other",
        title: (h.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.slice(0, 60) ?? null,
    };
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

async function captureChromeCookies() {
    const browser = await chromium.launch({
        channel: "chrome",
        headless: false,
        args: ["--incognito", "--disable-blink-features=AutomationControlled"],
    });
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        await page.goto("https://www.google.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
        await delay(2000);
        const { cookies } = await cdp.send("Network.getAllCookies");
        const google = (cookies || []).filter((c) => (c.domain || "").includes("google.com"));
        return google;
    } finally {
        await browser.close();
    }
}

async function captureVeloraHop1(cookies, label) {
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

    let hop1 = null;
    try {
        const b = await Browser.connect(endpoint);
        const page = await b.newPage();
        const cdp = page.session;
        await cdp.send("Network.enable");

        if (cookies?.length) {
            await cdp.send("Network.setCookies", { cookies });
        }

        let reqCookies = "";
        cdp.on("Network.requestWillBeSent", (p) => {
            if (p.type !== "Document") return;
            const url = p.request?.url || "";
            if (!url.includes("google.com/search") || url.includes("sei=")) return;
            reqCookies = p.request?.headers?.Cookie || p.request?.headers?.cookie || "";
        });

        cdp.on("Network.responseReceived", async (p) => {
            if (p.type !== "Document") return;
            const url = p.response?.url || "";
            if (!url.includes("google.com/search") || url.includes("sei=")) return;
            for (let i = 0; i < 30; i++) {
                try {
                    const body = await cdp.send("Network.getResponseBody", { requestId: p.requestId });
                    const html = body.base64Encoded
                        ? Buffer.from(body.body, "base64").toString("utf8")
                        : body.body;
                    hop1 = {
                        status: p.response?.status,
                        protocol: p.response?.protocol ?? null,
                        requestCookieNames: reqCookies.split(";").map((x) => x.trim().split("=")[0]).filter(Boolean),
                        bodyClass: classify(html),
                        html,
                    };
                    break;
                } catch {
                    await delay(50);
                }
            }
        });

        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
        for (let i = 0; i < 50 && !hop1; i++) await delay(100);
        await b.close();
        return { label, ...hop1 };
    } finally {
        proc.kill("SIGTERM");
    }
}

async function main() {
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    mkdirSync(OUT, { recursive: true });

    console.log("[1/3] Capture Chrome cookies after google.com...");
    const chromeCookies = await captureChromeCookies();
    writeFileSync(resolve(OUT, "chrome-cookies.json"), JSON.stringify(chromeCookies, null, 2));
    console.log(`  ${chromeCookies.length} google.com cookies: ${chromeCookies.map((c) => c.name).join(", ")}`);

    console.log("[2/3] Velora cold search (no injected cookies)...");
    const cold = await captureVeloraHop1(null, "velora-cold");
    if (cold?.html) writeFileSync(resolve(OUT, "velora-cold-hop1.html"), cold.html);

    console.log("[3/3] Velora search with Chrome cookies injected...");
    const replay = await captureVeloraHop1(chromeCookies, "velora-chrome-cookies");
    if (replay?.html) writeFileSync(resolve(OUT, "velora-replay-hop1.html"), replay.html);

    const report = {
        search: SEARCH,
        chromeCookieCount: chromeCookies.length,
        chromeCookieNames: chromeCookies.map((c) => c.name).sort(),
        cold: cold ? { ...cold, html: undefined } : null,
        replay: replay ? { ...replay, html: undefined } : null,
    };
    writeFileSync(resolve(OUT, "report.json"), JSON.stringify(report, null, 2));

    for (const r of [cold, replay]) {
        if (!r) { console.log(`  ${r?.label ?? "?"}: no capture`); continue; }
        console.log(
            `  ${r.label}: ${r.status} ${r.protocol ?? "?"} ${r.bodyClass?.page} ${r.bodyClass?.bytes}B`,
        );
        console.log(`    sent=[${(r.requestCookieNames || []).join(",")}] title=${r.bodyClass?.title}`);
    }
    console.log(`\nsaved: ${OUT}/report.json`);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});