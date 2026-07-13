#!/usr/bin/env node
/**
 * Google document fetch via real Chrome network stack (CDP, no Playwright).
 *
 * Prerequisite:
 *   CHROME_CDP=http://127.0.0.1:9222  (Chrome started with --remote-debugging-port=9222)
 *   velora-sdk: cd ../velora-sdk && npm install && npm run build
 *
 * stdin:  {"url":"https://...","headers":[["Name","value"],...]}
 * stdout: {"status":200,"finalUrl":"...","protocol":"h3","contentType":"...","bodyBase64":"..."}
 */
import { readFileSync } from "node:fs";

import { importChromeCdp } from "./lib/velora-sdk-root.mjs";

const { connectChrome, pageUrl } = await importChromeCdp();

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const input = JSON.parse(readFileSync(0, "utf8"));
const { url, headers = [] } = input;

const extra = {};
for (const [name, value] of headers) {
    if (!name || value == null) continue;
    const k = String(name);
    if (k.toLowerCase() === "cookie") continue;
    extra[k] = String(value);
}

const spawn = process.env.VELORA_CHROME_SPAWN === "1";

const { browser } = await connectChrome({
    endpoint: process.env.CHROME_CDP,
    spawn,
});

const page = await browser.newPage();
const cdp = page.session;

try {
    await cdp.send("Network.enable");
    if (Object.keys(extra).length) {
        const hdrs = Object.entries(extra).map(([name, value]) => ({ name, value }));
        await cdp.send("Network.setExtraHTTPHeaders", { headers: hdrs });
    }

    const sgssHop = url.includes("sg_ss=");
    let doc = null;
    cdp.on("Network.responseReceived", (p) => {
        if (p.type !== "Document") return;
        const u = p.response?.url || "";
        if (sgssHop) {
            if (!u.includes("google.com/search") && !u.includes("/sorry")) return;
            doc = {
                status: p.response?.status ?? 0,
                protocol: p.response?.protocol ?? null,
                url: u,
                requestId: p.requestId,
            };
            return;
        }
        if (!u.includes("google.com/search") || u.includes("sg_ss=")) return;
        const candidate = {
            status: p.response?.status ?? 0,
            protocol: p.response?.protocol ?? null,
            url: u,
            requestId: p.requestId,
            hasSei: u.includes("sei="),
        };
        if (!doc || (candidate.hasSei && !doc.hasSei)) doc = candidate;
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });

    if (!sgssHop) {
        for (let i = 0; i < 50; i++) {
            const u = await pageUrl(page);
            if (u.includes("sg_ss=") || u.includes("/sorry")) break;
            await delay(100);
        }
    } else {
        for (let i = 0; i < 30; i++) {
            const u = await pageUrl(page);
            if (u.includes("/sorry") || /SearchResultsPage/.test(await page.content().catch(() => ""))) break;
            await delay(100);
        }
    }
    await delay(500);

    const finalUrl = await pageUrl(page);

    if (!doc) {
        const body = await page.content().catch(() => "");
        if (body.length >= 256) {
            process.stdout.write(JSON.stringify({
                status: finalUrl.includes("/sorry") ? 429 : 200,
                finalUrl,
                protocol: null,
                contentType: "text/html; charset=UTF-8",
                bodyBase64: Buffer.from(body, "utf8").toString("base64"),
            }));
            process.exit(0);
        }
        process.stdout.write(JSON.stringify({
            error: "no_document_response",
            finalUrl,
        }));
        process.exit(1);
    }

    let body = "";
    for (let i = 0; i < 40; i++) {
        try {
            const res = await cdp.send("Network.getResponseBody", { requestId: doc.requestId });
            body = res.base64Encoded
                ? Buffer.from(res.body, "base64").toString("utf8")
                : res.body;
            if (body.length > 0) break;
        } catch {
            await delay(50);
        }
    }
    if (body.length < 256) {
        body = await page.content();
    }

    process.stdout.write(JSON.stringify({
        status: doc.status,
        finalUrl,
        protocol: doc.protocol,
        contentType: "text/html; charset=UTF-8",
        bodyBase64: Buffer.from(body, "utf8").toString("base64"),
    }));
} finally {
    await page.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
}