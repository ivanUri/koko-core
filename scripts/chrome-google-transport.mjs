#!/usr/bin/env node
/**
 * Google document fetch via real Chrome network stack (Phase 2b).
 * stdin:  {"url":"https://...","headers":[["Name","value"],...]}
 * stdout: {"status":200,"finalUrl":"...","protocol":"h3","contentType":"...","bodyBase64":"..."}
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const input = JSON.parse(readFileSync(0, "utf8"));
const { url, headers = [] } = input;

const extra = {};
for (const [name, value] of headers) {
    if (!name || value == null) continue;
    const k = String(name);
    if (k.toLowerCase() === "cookie") continue;
    extra[k] = String(value);
}

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
    if (Object.keys(extra).length) {
        await cdp.send("Network.setExtraHTTPHeaders", { headers: extra });
    }

    let doc = null;
    cdp.on("Network.responseReceived", (p) => {
        if (p.type !== "Document") return;
        const u = p.response?.url || "";
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
    // Guest Chrome may client-redirect to sg_ss= shortly after DOMContentLoaded.
    for (let i = 0; i < 50; i++) {
        const u = page.url();
        if (u.includes("sg_ss=") || u.includes("/sorry")) break;
        await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 500));

    if (!doc) {
        process.stdout.write(JSON.stringify({
            error: "no_document_response",
            finalUrl: page.url(),
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
            await new Promise((r) => setTimeout(r, 50));
        }
    }
    // CDP body can be empty after cross-document redirect; DOM snapshot is the fallback.
    if (body.length < 256) {
        body = await page.content();
    }

    const contentType = /SearchResultsPage/.test(body)
        ? "text/html; charset=UTF-8"
        : "text/html; charset=UTF-8";

    process.stdout.write(JSON.stringify({
        status: doc.status,
        finalUrl: page.url(),
        protocol: doc.protocol,
        contentType,
        bodyBase64: Buffer.from(body, "utf8").toString("base64"),
    }));
} finally {
    await browser.close();
}