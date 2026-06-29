#!/usr/bin/env node
/**
 * After navigation, inspect where knitsail might have been assigned (p vs globalThis).
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

const HOOK = `(() => {
    if (globalThis.__postEvalProbe) return;
    const orig = globalThis.eval;
    globalThis.__postEvalProbe = [];
    globalThis.eval = function(code) {
        const text = typeof code === "string" ? code : String(code);
        const res = orig.call(globalThis, code);
        if (text.includes("knitsail")) {
            globalThis.__postEvalProbe.push({
                kn: typeof globalThis.knitsail,
                selfKn: typeof self.knitsail,
                windowKn: typeof window.knitsail,
                keysOnGlobal: Object.getOwnPropertyNames(globalThis).filter(k => k.includes("knit")),
                readyState: document.readyState,
            });
        }
        return res;
    };
})();`;

async function serveHtml(htmlPath, port) {
    const html = await readFile(htmlPath, "utf8");
    const server = createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
    });
    await new Promise((r) => server.listen(port, "127.0.0.1", r));
    return server;
}

async function main() {
    const htmlPath = resolve(
        REPO,
        "google-search-debug/tmp/trace-velora-2026-06-28T18-19-39-463Z/response.html",
    );
    const httpPort = await getFreePort();
    const veloraPort = await getFreePort();
    const server = await serveHtml(htmlPath, httpPort);
    const launch = await spawnVelora("chrome-local-huys-macbook-pro", veloraPort);
    const { client, sessionId } = await connectCdp(launch.endpoint);

    try {
        await client.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK }, sessionId);
        const url = `http://127.0.0.1:${httpPort}/`;
        await client.send("Page.navigate", { url }, sessionId);
        await delay(6000);
        const res = await client.send("Runtime.evaluate", {
            expression: `({
                kn: typeof globalThis.knitsail,
                probe: globalThis.__postEvalProbe,
                ownNames: Object.getOwnPropertyNames(globalThis).filter(k => /knit|Tf|GOs/i.test(k)).slice(0,30),
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