#!/usr/bin/env node
/**
 * Inject a probe script between inline scripts 2 and 3 in saved HTML.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
    REPO,
    connectCdp,
    getFreePort,
    spawnVelora,
    killProc,
} from "../lib/cdp.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE_SCRIPT = `<script>window.__between23={kn:typeof globalThis.knitsail,rs:document.readyState,ts:Date.now()};</script>`;

function injectProbe(html) {
    const scripts = [];
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
    let last = 0;
    let m;
    let inlineIdx = -1;
    const parts = [];
    while ((m = re.exec(html))) {
        parts.push({ start: m.index, end: re.lastIndex, full: m[0], attrs: m[1] || "", body: m[2] || "" });
    }
    for (const p of parts) {
        if (/src\s*=/i.test(p.attrs)) continue;
        if (!(p.body || "").trim()) continue;
        inlineIdx += 1;
        if (inlineIdx === 2) {
            // after script 2 closes, inject probe before script 3
            return html.slice(0, p.end) + PROBE_SCRIPT + html.slice(p.end);
        }
    }
    throw new Error("Could not find inline script index 2");
}

async function main() {
    const htmlPath = resolve(
        REPO,
        "google-search-debug/tmp/trace-velora-2026-06-28T18-19-39-463Z/response.html",
    );
    const html = injectProbe(await readFile(htmlPath, "utf8"));

    const httpPort = await getFreePort();
    const veloraPort = await getFreePort();
    const server = createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
    });
    await new Promise((r) => server.listen(httpPort, "127.0.0.1", r));

    const launch = await spawnVelora("chrome-local-huys-macbook-pro", veloraPort);
    const { client, sessionId } = await connectCdp(launch.endpoint);

    try {
        await client.send("Page.navigate", { url: `http://127.0.0.1:${httpPort}/` }, sessionId);
        await delay(5000);
        const res = await client.send("Runtime.evaluate", {
            expression: `({
                between23: window.__between23,
                final: { kn: typeof globalThis.knitsail, sn: window.google?.sn, title: document.title },
                scriptCount: document.scripts.length,
            })`,
            returnByValue: true,
        }, sessionId);
        console.log(JSON.stringify(res.result?.value, null, 2));
    } finally {
        client.close();
        killProc(launch.proc);
        server.close();
    }
}

main().catch((e) => { console.error(e); process.exit(2); });