#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { REPO, connectCdp, getFreePort, spawnVelora, killProc } from "../lib/cdp.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function injectProbes(html) {
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
    const parts = [];
    let m;
    while ((m = re.exec(html))) parts.push({ end: re.lastIndex, attrs: m[1] || "", body: m[2] || "" });
    let inlineIdx = -1;
    let out = html;
    let offset = 0;
    for (const p of parts) {
        if (/src\s*=/i.test(p.attrs)) continue;
        if (!(p.body || "").trim()) continue;
        inlineIdx += 1;
        const probe = `<script>window.__ck${inlineIdx}={kn:typeof globalThis.knitsail,rs:document.readyState};</script>`;
        const pos = p.end + offset;
        out = out.slice(0, pos) + probe + out.slice(pos);
        offset += probe.length;
    }
    // after all inline scripts, add DCL probe
    const dcl = `<script>document.addEventListener('DOMContentLoaded',()=>{window.__ckDCL={kn:typeof globalThis.knitsail,rs:document.readyState};});</script>`;
    out = out.replace("</body>", dcl + "</body>");
    return out;
}

async function main() {
    const htmlPath = resolve(REPO, "google-search-debug/tmp/trace-velora-2026-06-28T18-19-39-463Z/response.html");
    const html = injectProbes(await readFile(htmlPath, "utf8"));
    const httpPort = await getFreePort();
    const veloraPort = await getFreePort();
    const server = createServer((req, res) => { res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"}); res.end(html); });
    await new Promise((r) => server.listen(httpPort, "127.0.0.1", r));
    const launch = await spawnVelora("chrome-local-huys-macbook-pro", veloraPort);
    const { client, sessionId } = await connectCdp(launch.endpoint);
    try {
        await client.send("Page.navigate", { url: `http://127.0.0.1:${httpPort}/` }, sessionId);
        for (const ms of [100, 500, 2000, 5000]) {
            await delay(ms);
            const res = await client.send("Runtime.evaluate", {
                expression: `({
                    t:${ms},
                    ck0:window.__ck0,ck1:window.__ck1,ck2:window.__ck2,ck3:window.__ck3,ck4:window.__ck4,ckDCL:window.__ckDCL,
                    now:{kn:typeof globalThis.knitsail,sn:window.google?.sn,title:document.title,rs:document.readyState}
                })`,
                returnByValue: true,
            }, sessionId);
            console.log(JSON.stringify(res.result?.value));
        }
    } finally { client.close(); killProc(launch.proc); server.close(); }
}

main().catch((e) => { console.error(e); process.exit(2); });