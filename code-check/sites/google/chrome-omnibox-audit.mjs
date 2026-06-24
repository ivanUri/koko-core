#!/usr/bin/env node
/**
 * Capture real Chrome omnibox → Google SERP network (guest HAR baseline).
 * Output: code-check/tmp/chrome-omnibox-audit/report.json
 */
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const OUT = resolve(repoRoot, "code-check/tmp/chrome-omnibox-audit");
const QUERY = process.argv[2] || "coingloo.com";
const SEARCH = `https://www.google.com/search?q=${encodeURIComponent(QUERY)}`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

function classify(html) {
    const h = String(html || "");
    return {
        bytes: Buffer.byteLength(h, "utf8"),
        page: /SearchResultsPage/.test(h) ? "SERP" : /window\.sgs/.test(h) ? "SGS" : /sorry/i.test(h) ? "sorry" : "other",
    };
}

function hopKind(url) {
    if (url.includes("/sorry")) return "sorry";
    if (url.includes("sg_ss=")) return "sg_ss";
    if (url.includes("sei=")) return "sei";
    if (url.includes("google.com/search")) return "search";
    return "other";
}

async function main() {
    mkdirSync(OUT, { recursive: true });

    const browser = await chromium.launch({
        channel: "chrome",
        headless: true,
        args: ["--incognito", "--disable-blink-features=AutomationControlled"],
    });

    const events = [];
    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");

        const bodies = new Map();

        cdp.on("Network.requestWillBeSent", (p) => {
            if (p.type !== "Document") return;
            const url = p.request?.url || "";
            if (!url.includes("google.com")) return;
            events.push({
                phase: "request",
                ts: p.timestamp,
                kind: hopKind(url),
                url: url.slice(0, 200),
                method: p.request?.method,
                protocol: null,
                headers: hdrMap(p.request?.headers),
                headerOrder: Array.isArray(p.request?.headers)
                    ? p.request.headers.map((h) => h.name)
                    : Object.keys(p.request?.headers || {}),
            });
        });

        cdp.on("Network.responseReceived", (p) => {
            if (p.type !== "Document") return;
            const url = p.response?.url || "";
            if (!url.includes("google.com")) return;
            events.push({
                phase: "response",
                ts: p.timestamp,
                kind: hopKind(url),
                url: url.slice(0, 200),
                status: p.response?.status,
                protocol: p.response?.protocol,
                mimeType: p.response?.mimeType,
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

        console.log(`[chrome-audit] goto ${SEARCH}`);
        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
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
            query: QUERY,
            search: SEARCH,
            finalUrl: finalUrl.slice(0, 240),
            dom,
            documentHops: events,
            summary: {
                hopCount: events.filter((e) => e.phase === "request").length,
                protocols: [...new Set(events.filter((e) => e.protocol).map((e) => e.protocol))],
                sorry: finalUrl.includes("/sorry") || dom.page === "sorry",
                serp: dom.page === "SERP",
            },
            veloraNativeChecklist: [
                "HTTP/3 (h3) with Chrome QUIC transport params (h3_hash ba909fc3…)",
                "Header order: accept → encoding → language → downlink → priority → referer → rtt → client hints → fetch → UA → x-browser-*",
                "sec-fetch-site: same-origin + referer q-only on sei= hop",
                "omit sec-fetch-user on google search flow",
                "zero Cookie on first sei= document hop",
                "x-browser-channel/copyright/validation/year",
            ],
        };

        writeFileSync(resolve(OUT, "report.json"), JSON.stringify(report, null, 2));

        console.log("\n=== Chrome omnibox audit ===");
        for (const e of events.filter((x) => x.phase === "response")) {
            const b = e.bodyClass;
            console.log(
                `${e.protocol ?? "?"} ${e.status ?? "?"} ${e.kind} ${b?.page ?? "?"} ${b?.bytes ?? 0}B`,
            );
            console.log(`  ${e.url.slice(0, 90)}`);
        }
        console.log(`\nfinal: ${report.finalUrl}`);
        console.log(`dom: ${dom.page} ${dom.bytes}B`);
        console.log(`saved: ${OUT}/report.json`);
    } finally {
        await browser.close();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});