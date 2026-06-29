#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { REPO, buildSearchUrl, connectCdp, getFreePort, spawnVelora, killProc } from "../lib/cdp.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function extract(html) {
    const out = [];
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
        if (/src\s*=/i.test(m[1] || "")) continue;
        const body = (m[2] || "").trim();
        if (body) out.push(body.length);
    }
    return out;
}

async function main() {
    const html = await readFile(resolve(REPO, "google-search-debug/tmp/trace-velora-2026-06-28T18-19-39-463Z/response.html"), "utf8");
    const expected = extract(html);
    const port = await getFreePort();
    const launch = await spawnVelora("chrome-local-huys-macbook-pro", port);
    const { client, sessionId } = await connectCdp(launch.endpoint);
    try {
        await client.send("Runtime.enable", {}, sessionId);
        await client.send("Page.navigate", { url: buildSearchUrl("test") }, sessionId);
        await delay(20000);
        const res = await client.send("Runtime.evaluate", {
            expression: `[...document.scripts].map((s, i) => ({
                i, inline: !s.src, len: (s.textContent || "").length,
                executedGuess: (s.textContent || "").includes("knitsail"),
            }))`,
            returnByValue: true,
        }, sessionId);
        const dom = res.result?.value || [];
        console.log("Expected lengths:", expected);
        console.log("DOM scripts:", JSON.stringify(dom, null, 2));

        // Replay 2+3 on navigated page without prior replay
        const scripts = [];
        const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
        let m;
        while ((m = re.exec(html))) {
            if (/src\s*=/i.test(m[1] || "")) continue;
            const body = (m[2] || "").trim();
            if (body) scripts.push(body);
        }
        for (const idx of [2, 3]) {
            const r = await client.send("Runtime.evaluate", {
                expression: `(function(){ try { ${scripts[idx]}; return {ok:true, kn: typeof globalThis.knitsail, sn: window.google?.sn}; } catch(e) { return {ok:false, err: String(e)}; } })()`,
                returnByValue: true,
                timeout: 120000,
            }, sessionId);
            console.log(`replay ${idx}:`, r.result?.value || r.exceptionDetails?.text);
        }
    } finally {
        client.close();
        killProc(launch.proc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });