#!/usr/bin/env node
/**
 * Navigate Velora to locally-served saved Google HTML (no network variance).
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

        const url = `http://127.0.0.1:${httpPort}/`;
        await client.send("Page.navigate", { url }, sessionId);
        await delay(8000);

        const probe = await client.send("Runtime.evaluate", {
            expression: `({
                kn: typeof globalThis.knitsail,
                knA: typeof globalThis.knitsail?.a,
                sn: window.google?.sn ?? null,
                title: document.title,
                scripts: document.scripts.length,
                readyState: document.readyState,
                location: location.href,
            })`,
            returnByValue: true,
        }, sessionId);

        console.log(JSON.stringify({
            url,
            probe: probe.result?.value,
            exceptions,
        }, null, 2));
    } finally {
        client.close();
        killProc(launch.proc);
        server.close();
    }
}

main().catch((e) => { console.error(e); process.exit(2); });