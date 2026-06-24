#!/usr/bin/env node
// Trace Google search sg_ss flow — capture document requests + responses.
//
// Usage: node code-check/sites/google/trace-sgss.mjs
// Output: code-check/tmp/google-sgss/trace.json

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const OUT = resolve(repoRoot, "code-check/tmp/google-sgss");
const SEARCH = "https://www.google.com/search?q=coingloo&hl=en";

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

function classifyUrl(url) {
    if (url.includes("/sorry")) return "sorry";
    if (url.includes("sg_ss=")) return "sg_ss";
    if (url.includes("/search?")) return "search";
    return "other";
}

async function main() {
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    await mkdir(OUT, { recursive: true });

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
    const events = [];
    const t0 = Date.now();

    try {
        const page = await browser.newPage();
        const cdp = page.session;
        await cdp.send("Network.enable");

        cdp.on("Network.requestWillBeSent", (p) => {
            const url = p.request?.url ?? "";
            if (!/google\.com/.test(url)) return;
            events.push({
                phase: "request",
                atMs: Date.now() - t0,
                requestId: p.requestId,
                type: p.type,
                url: url.slice(0, 300),
                kind: classifyUrl(url),
                method: p.request?.method,
                redirectResponse: p.redirectResponse?.status ?? null,
                headers: {
                    referer: hdr(p.request?.headers, "referer"),
                    cookie: hdr(p.request?.headers, "cookie"),
                    "sec-fetch-site": hdr(p.request?.headers, "sec-fetch-site"),
                    "sec-fetch-mode": hdr(p.request?.headers, "sec-fetch-mode"),
                    "sec-fetch-dest": hdr(p.request?.headers, "sec-fetch-dest"),
                    "sec-fetch-user": hdr(p.request?.headers, "sec-fetch-user"),
                    "sec-ch-ua": hdr(p.request?.headers, "sec-ch-ua"),
                    "user-agent": hdr(p.request?.headers, "user-agent"),
                },
            });
        });

        cdp.on("Network.responseReceived", (p) => {
            const url = p.response?.url ?? "";
            if (!/google\.com/.test(url)) return;
            events.push({
                phase: "response",
                atMs: Date.now() - t0,
                requestId: p.requestId,
                url: url.slice(0, 300),
                kind: classifyUrl(url),
                status: p.response?.status,
                statusText: p.response?.statusText,
                mimeType: p.response?.mimeType,
                headers: {
                    location: hdr(p.response?.headers, "location"),
                    "set-cookie": hdr(p.response?.headers, "set-cookie"),
                },
            });
        });

        console.log(`[goto] ${SEARCH}`);
        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await delay(3000);

        const final = await page.evaluate(() => ({
            url: location.href,
            title: document.title,
            sorry: location.href.includes("/sorry"),
            hits: document.querySelectorAll("#search .g h3, .MjjYud h3").length,
        }));

        // Velora SDK network map
        const sdkReqs = [...page.network.requests.values()]
            .filter((r) => /google\.com/.test(r.url))
            .map((r) => ({
                url: r.url.slice(0, 300),
                kind: classifyUrl(r.url),
                status: r.response?.status,
                failure: r.failureText,
                redirectChain: r.redirectChain,
            }));

        const docFlow = events.filter((e) =>
            e.kind !== "other" || (e.phase === "response" && e.status >= 300)
        );

        const searchReqs = events.filter((e) => e.phase === "request" && e.kind === "search");
        const sgssReqs = events.filter((e) => e.phase === "request" && e.kind === "sg_ss");
        const searchRes = events.filter((e) => e.phase === "response" && e.kind === "search");
        const sgssRes = events.filter((e) => e.phase === "response" && e.kind === "sg_ss");

        const report = {
            searchUrl: SEARCH,
            final,
            summary: {
                searchRequests: searchReqs.length,
                sgssRequests: sgssReqs.length,
                searchStatuses: searchRes.map((r) => r.status),
                sgssStatuses: sgssRes.map((r) => r.status),
                deltaMs: sgssReqs[0] && searchReqs[0]
                    ? sgssReqs[0].atMs - searchReqs[0].atMs
                    : null,
            },
            docFlow,
            sdkReqs,
        };

        await writeFile(resolve(OUT, "trace.json"), JSON.stringify(report, null, 2));

        console.log("\n=== sg_ss trace ===");
        console.log(`final: ${final.url.slice(0, 100)}`);
        console.log(`sorry: ${final.sorry} hits: ${final.hits}`);
        console.log(`search statuses: ${report.summary.searchStatuses.join(", ")}`);
        console.log(`sg_ss statuses:  ${report.summary.sgssStatuses.join(", ")}`);
        console.log(`delta search→sg_ss: ${report.summary.deltaMs}ms`);
        console.log("\n--- document flow ---");
        for (const e of docFlow) {
            if (e.phase === "request") {
                console.log(`[${e.atMs}ms] REQ ${e.method} ${e.kind} ${e.url.slice(0, 90)}`);
                console.log(`  referer: ${(e.headers.referer || "").slice(0, 80)}`);
                console.log(`  cookie:  ${e.headers.cookie ? `${e.headers.cookie.length} chars` : "(none)"}`);
                console.log(`  fetch:   site=${e.headers["sec-fetch-site"]} mode=${e.headers["sec-fetch-mode"]} dest=${e.headers["sec-fetch-dest"]}`);
            } else {
                console.log(`[${e.atMs}ms] RES ${e.status} ${e.kind} loc=${(e.headers.location || "").slice(0, 60)}`);
            }
        }
        console.log(`\nsaved: ${OUT}/trace.json`);
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});