#!/usr/bin/env node
/**
 * Compare knitsail state: live navigation vs post-hoc script replay on same session.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
    REPO,
    buildSearchUrl,
    connectCdp,
    getFreePort,
    spawnVelora,
    killProc,
} from "../lib/cdp.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function extractInlineScripts(html) {
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

async function probe(client, sessionId, label) {
    const res = await client.send("Runtime.evaluate", {
        expression: `(() => ({
            label: ${JSON.stringify(label)},
            knitsail: typeof globalThis.knitsail,
            knitsailA: typeof globalThis.knitsail?.a,
            googleSn: window.google?.sn ?? null,
            scriptCount: document.scripts.length,
            title: document.title,
        }))()`,
        returnByValue: true,
    }, sessionId);
    return res.result?.value;
}

async function runScript(client, sessionId, code, label) {
    const res = await client.send("Runtime.evaluate", {
        expression: `(() => { try { ${code}; return {ok:true}; } catch(e) { return {ok:false, err:String(e.message||e)}; } })()`,
        returnByValue: true,
        timeout: 120000,
    }, sessionId);
    if (res.exceptionDetails) return { label, evalErr: res.exceptionDetails.text };
    const body = res.result?.value;
    return { label, ...body, after: await probe(client, sessionId, `${label}-after`) };
}

async function main() {
    const htmlPath = resolve(REPO, "google-search-debug/tmp/trace-velora-2026-06-28T18-19-39-463Z/response.html");
    const html = await readFile(htmlPath, "utf8");
    const scripts = extractInlineScripts(html);

    const port = await getFreePort();
    const launch = await spawnVelora("chrome-local-huys-macbook-pro", port);
    const { client, sessionId } = await connectCdp(launch.endpoint);
    const report = { phases: [] };

    try {
        await client.send("Runtime.enable", {}, sessionId);
        const exceptions = [];
        client.ws.on("message", (raw) => {
            try {
                const m = JSON.parse(String(raw));
                if (m.method === "Runtime.exceptionThrown") {
                    exceptions.push({
                        text: m.params?.exceptionDetails?.text,
                        url: m.params?.exceptionDetails?.url,
                        line: m.params?.exceptionDetails?.lineNumber,
                    });
                }
            } catch {}
        });

        await client.send("Page.navigate", { url: buildSearchUrl("test") }, sessionId);
        await delay(25000);
        report.phases.push({ step: "after-navigate", probe: await probe(client, sessionId, "navigate"), exceptions: [...exceptions] });

        // Replay only knitsail loader (script index 2) on the live degraded document
        report.phases.push({
            step: "replay-script-2-on-live-doc",
            result: await runScript(client, sessionId, scripts[2], "replay-2"),
        });

        // Reset tab: replay scripts 0-3 on about:blank
        await client.send("Page.navigate", { url: "about:blank" }, sessionId);
        await delay(500);
        const seq = [];
        for (let i = 0; i <= 3; i += 1) {
            seq.push(await runScript(client, sessionId, scripts[i], `fresh-${i}`));
        }
        report.phases.push({ step: "about-blank-replay-0-3", seq });

        console.log(JSON.stringify(report, null, 2));
        const out = resolve(REPO, "google-search-debug/tmp/diagnose-navigation.json");
        await import("node:fs/promises").then((fs) => fs.writeFile(out, JSON.stringify(report, null, 2)));
        console.log(`\nSaved: ${out}`);
    } finally {
        client.close();
        killProc(launch.proc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });