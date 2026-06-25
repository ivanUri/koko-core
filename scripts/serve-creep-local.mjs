#!/usr/bin/env node
/**
 * Static server for local CreepJS files.
 *
 * Usage:
 *   node scripts/serve-creep-local.mjs
 *   node scripts/serve-creep-local.mjs --port 8765
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const SITE_DIR = resolve(REPO, "code-check/sites/creep");

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
};

function parseArgs(argv) {
    const out = { port: 8765, host: "127.0.0.1" };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--port") out.port = Number(argv[++i]);
        else if (argv[i] === "--host") out.host = argv[++i];
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const server = createServer(async (req, res) => {
        const url = new URL(req.url || "/", `http://${args.host}`);
        let path = decodeURIComponent(url.pathname);
        if (path === "/") path = "/index.html";

        const filePath = resolve(SITE_DIR, path.replace(/^\//, ""));
        if (!filePath.startsWith(SITE_DIR) || !existsSync(filePath)) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("not found: " + path);
            return;
        }

        try {
            const body = await readFile(filePath);
            const ext = extname(filePath);
            res.writeHead(200, {
                "Content-Type": MIME[ext] || "application/octet-stream",
                "Cache-Control": "no-store",
            });
            res.end(body);
        } catch (e) {
            res.writeHead(500, { "Content-Type": "text/plain" });
            res.end(String(e.message || e));
        }
    });

    await new Promise((res, rej) => {
        server.once("error", rej);
        server.listen(args.port, args.host, res);
    });

    const base = `http://${args.host}:${args.port}`;
    console.log(`creep local server: ${base}`);
    console.log(`  full:  ${base}/index.html`);
    console.log(`  audio: ${base}/audio-probe.html`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});