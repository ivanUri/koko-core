#!/usr/bin/env node
// Minimal Turnstile test with auto-pass sitekey (no click required).
//
// Usage: node code-check/sites/recaptcha/turnstile-local-test.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const interactive = process.argv.includes("--interactive");
const htmlPath = resolve(__dirname, interactive ? "turnstile-local-interactive.html" : "turnstile-local.html");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function getFreePort() {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
        s.on("error", rej);
    });
}

async function spawnVelora(logLevel = "info") {
    const port = await getFreePort();
    const stderr = [];
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-catalina",
        "--log-level", logLevel, "--log-format", "pretty",
    ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", (c) => stderr.push(c));
    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i++) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {}
        await delay(100);
    }
    return { proc, endpoint, stderr };
}

function startStaticServer() {
    const html = readFileSync(htmlPath, "utf8");
    return new Promise((res) => {
        const srv = createServer((req, res_) => {
            res_.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            res_.end(html);
        });
        srv.listen(0, "127.0.0.1", () => res(srv));
    });
}

async function main() {
    if (!existsSync(veloraBin)) throw new Error("Run zig build first");

    const staticSrv = await startStaticServer();
    const { port: staticPort } = staticSrv.address();
    const pageUrl = `http://127.0.0.1:${staticPort}/`;

    const { proc, endpoint, stderr } = await spawnVelora();
    const browser = await Browser.connect(endpoint);
    const page = await browser.newPage();

    console.log(`[goto] ${pageUrl}`);
    await page.goto(pageUrl, { waitUntil: "load", timeout: 60_000 });

    if (interactive) {
        await page.session.send("Input.enable").catch(() => undefined);
        await delay(8000);
        const pt = await page.evaluate(() => {
            const w = document.querySelector(".cf-turnstile");
            const r = w.getBoundingClientRect();
            return { x: r.left + 28, y: r.top + r.height / 2 };
        });
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
            await page.session.send("Input.dispatchMouseEvent", {
                type, x: pt.x, y: pt.y,
                button: type === "mouseMoved" ? "none" : "left",
                clickCount: type === "mousePressed" ? 1 : 0,
            });
            await delay(100);
        }
    }

    let tokenLen = 0;
    const polls = interactive ? 25 : 30;
    for (let i = 0; i < polls; i++) {
        tokenLen = await page.evaluate(() =>
            document.querySelector('[name="cf-turnstile-response"]')?.value?.length ?? 0
        );
        if (tokenLen > 0) break;
        await delay(2000);
    }

    const log = Buffer.concat(stderr).toString("utf8");
    const pmEvents = log.split("\n").filter((l) => {
        try {
            const j = JSON.parse(l);
            return j.msg?.includes?.("postMessage") || j.fields?.event === "message";
        } catch { return false; }
    });

    console.log(`tokenLen: ${tokenLen}`);
    console.log(`passed: ${tokenLen > 0}`);
    if (pmEvents.length) console.log("postMessage-related logs:", pmEvents.length);

    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    proc.kill("SIGTERM");
    staticSrv.close();

    process.exitCode = tokenLen > 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });