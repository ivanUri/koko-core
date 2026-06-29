#!/usr/bin/env node
/**
 * Hook eval during parser-inserted script execution to see if knitsail loader eval fails.
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
    if (globalThis.__evalHook) return;
    globalThis.__evalHook = { calls: [], indirect: [], errors: [] };
    const orig = globalThis.eval;
    const asText = (code) => {
        if (typeof code === "string") return code;
        try { return String(code); } catch { return ""; }
    };
    globalThis.eval = function(code) {
        const text = asText(code);
        const entry = {
            len: text.length,
            trusted: typeof code !== "string",
            hasKnitsail: text.includes("knitsail"),
            hasClosure: text.includes("closureDynamicButton"),
            readyState: document.readyState,
            parsing: document.readyState === "loading",
        };
        globalThis.__evalHook.calls.push(entry);
        try {
            return orig.call(globalThis, code);
        } catch (e) {
            globalThis.__evalHook.errors.push({
                msg: String(e?.message || e),
                stack: String(e?.stack || "").slice(0, 500),
                ...entry,
            });
            throw e;
        }
    };
    // Track indirect eval too
    const desc = Object.getOwnPropertyDescriptor(globalThis, "eval");
    if (desc?.value) {
        // already patched above
    }
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
        await client.send("Runtime.enable", {}, sessionId);
        await client.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK }, sessionId);

        const url = `http://127.0.0.1:${httpPort}/`;
        await client.send("Page.navigate", { url }, sessionId);
        await delay(6000);

        const res = await client.send("Runtime.evaluate", {
            expression: `({
                kn: typeof globalThis.knitsail,
                hook: globalThis.__evalHook,
                readyState: document.readyState,
                title: document.title,
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