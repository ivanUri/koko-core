#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { REPO, buildSearchUrl, connectCdp, getFreePort, spawnVelora, killProc } from "../lib/cdp.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function extractScripts(html) {
    const out = [];
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
        if (/src\s*=/i.test(m[1] || "")) continue;
        const body = (m[2] || "").trim();
        if (body) out.push(body);
    }
    return out;
}

function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
        if (a[i] !== b[i]) return { index: i, a: a[i], b: b[i], ctxA: a.slice(Math.max(0, i - 40), i + 40), ctxB: b.slice(Math.max(0, i - 40), i + 40) };
    }
    if (a.length !== b.length) return { index: n, lenA: a.length, lenB: b.length, tailA: a.slice(-80), tailB: b.slice(-80) };
    return null;
}

async function main() {
    const html = await readFile(resolve(REPO, "google-search-debug/tmp/trace-velora-2026-06-28T18-19-39-463Z/response.html"), "utf8");
    const expected = extractScripts(html);
    const port = await getFreePort();
    const launch = await spawnVelora("chrome-local-huys-macbook-pro", port);
    const { client, sessionId } = await connectCdp(launch.endpoint);
    try {
        await client.send("Page.navigate", { url: buildSearchUrl("test") }, sessionId);
        await delay(20000);
        const res = await client.send("Runtime.evaluate", {
            expression: `document.scripts[2].textContent`,
            returnByValue: true,
        }, sessionId);
        const dom = res.result?.value || "";
        console.log("expected len:", expected[2].length);
        console.log("dom len:", dom.length);
        console.log("delta:", expected[2].length - dom.length);
        const diff = firstDiff(expected[2], dom);
        console.log("diff:", JSON.stringify(diff, null, 2));
        console.log("expected ends:", expected[2].slice(-120));
        console.log("dom ends:", dom.slice(-120));
        console.log("knitsail in expected:", expected[2].includes("knitsail"));
        console.log("knitsail in dom:", dom.includes("knitsail"));
        const idxE = expected[2].indexOf("knitsail");
        const idxD = dom.indexOf("knitsail");
        console.log("knitsail idx expected/dom:", idxE, idxD);
    } finally {
        client.close();
        killProc(launch.proc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });