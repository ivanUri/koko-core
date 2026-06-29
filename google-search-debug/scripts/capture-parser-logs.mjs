#!/usr/bin/env node
/**
 * Capture Velora stderr during local-HTML navigation (parser path, no network).
 */
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

import { REPO, getFreePort, killProc, connectCdp } from "../lib/cdp.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const VELORA = resolve(REPO, "zig-out/bin/velora");

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

    const lines = [];
    const proc = spawn(VELORA, [
        "serve", "--host", "127.0.0.1", "--port", String(veloraPort),
        "--browser-profile", "chrome-local-huys-macbook-pro",
        "--log-level", "info",
    ], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", (d) => lines.push(String(d)));
    proc.stdout.on("data", (d) => lines.push(String(d)));

    try {
        const base = `http://127.0.0.1:${veloraPort}`;
        const t0 = Date.now();
        while (Date.now() - t0 < 15000) {
            try {
                if ((await fetch(`${base}/json/version`)).ok) break;
            } catch {}
            await delay(100);
        }

        const { client, sessionId } = await connectCdp(base);
        try {
            await client.send("Page.navigate", { url: `http://127.0.0.1:${httpPort}/` }, sessionId);
            await delay(3000);
            const probe = await client.send("Runtime.evaluate", {
                expression: "JSON.stringify({kn:typeof globalThis.knitsail,sn:window.google?.sn})",
                returnByValue: true,
            }, sessionId);
            console.log("PROBE", probe.result?.value);
        } finally {
            client.close();
        }
    } finally {
        killProc(proc);
        server.close();
    }

    const text = lines.join("");
    const out = resolve(REPO, "google-search-debug/tmp/parser-path-info.log");
    await mkdir(resolve(REPO, "google-search-debug/tmp"), { recursive: true });
    await writeFile(out, text);

    const hits = text.split("\n").filter((l) =>
        /executing script|eval script|Script compilation|Script execution|executed script|trusted-types/i.test(l));
    console.log(`\n--- ${hits.length} log hits ---`);
    console.log(hits.join("\n"));
    console.log(`\nlog bytes: ${text.length} -> ${out}`);
}

main().catch((e) => { console.error(e); process.exit(2); });