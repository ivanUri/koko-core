#!/usr/bin/env node
// Parse guest Chrome HAR (fresh session) → hop-1 SERP baseline vs Velora.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const OUT = resolve(repoRoot, "code-check/tmp/google-guest-har");
const HAR_PATH = process.argv[2] || "/Users/huydev/Desktop/www.google.com.har";

function hdrMap(headers) {
    const out = {};
    for (const h of headers || []) out[h.name.toLowerCase()] = h.value;
    return out;
}

function classify(html) {
    const h = String(html || "");
    return {
        bytes: Buffer.byteLength(h, "utf8"),
        page: /SearchResultsPage/.test(h) ? "SERP" : /window\.sgs/.test(h) ? "SGS" : "other",
    };
}

const har = JSON.parse(readFileSync(HAR_PATH, "utf8"));
const searchDocs = har.log.entries
    .filter((e) => e.request.url.includes("www.google.com/search") && !e.request.url.includes("sg_ss="))
    .sort((a, b) => new Date(a.startedDateTime) - new Date(b.startedDateTime));

const first = searchDocs[0];
const req = hdrMap(first.request.headers);
const res = hdrMap(first.response.headers);
const body = first.response.content?.text || "";

const report = {
    harPath: HAR_PATH,
    firstSearch: {
        url: first.request.url,
        started: first.startedDateTime,
        status: first.response.status,
        protocol: first.response.httpVersion,
        bodyClass: classify(body),
        request: {
            headerOrder: first.request.headers.map((h) => h.name),
            cookieNames: (req.cookie || "").split(";").map((x) => x.trim().split("=")[0]).filter(Boolean),
            cookieLen: (req.cookie || "").length,
            secFetchSite: req["sec-fetch-site"],
            secFetchUser: req["sec-fetch-user"] || null,
            referer: req.referer || null,
            downlink: req.downlink || null,
            hasXBrowser: !!req["x-browser-validation"],
            xBrowserValidation: req["x-browser-validation"] || null,
            cacheControl: req["cache-control"] || null,
            pragma: req.pragma || null,
        },
        response: {
            setCookieNames: (first.response.headers || [])
                .filter((h) => h.name.toLowerCase() === "set-cookie")
                .map((h) => h.value.split("=")[0]),
            altSvc: res["alt-svc"] || null,
        },
    },
    veloraGaps: [
        "HTTP/3 (h3) — Velora was h2",
        "x-browser-* headers",
        "downlink: 10 (was 7.85)",
        "sec-fetch-site: same-origin + referer (omnibox/search redirect flow)",
        "Guest Chrome sends zero cookies on SERP hop",
        "cache-control/pragma absent in guest HAR (removed from Velora)",
    ],
};

mkdirSync(OUT, { recursive: true });
writeFileSync(resolve(OUT, "guest-har-report.json"), JSON.stringify(report, null, 2));

console.log("=== Guest Chrome HAR (hop-1 search) ===");
console.log(`protocol: ${report.firstSearch.protocol}`);
console.log(`page: ${report.firstSearch.bodyClass.page} ${report.firstSearch.bodyClass.bytes}B`);
console.log(`cookies sent: ${report.firstSearch.request.cookieLen === 0 ? "(none)" : report.firstSearch.request.cookieNames.join(",")}`);
console.log(`sec-fetch-site: ${report.firstSearch.request.secFetchSite}`);
console.log(`referer: ${report.firstSearch.request.referer || "(none)"}`);
console.log(`x-browser-validation: ${report.firstSearch.request.xBrowserValidation || "(none)"}`);
console.log(`\nsaved: ${OUT}/guest-har-report.json`);