#!/usr/bin/env node
/** Capture fresh sg_ss URL from Velora, curl it immediately with chrome146. */
import { spawn, execFileSync } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const CURL = resolve(REPO, "vendor/curl-impersonate/curl_chrome146");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function getFreePort() {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.unref();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
    });
}

async function main() {
    const port = await getFreePort();
    const proc = spawn(VELORA_BIN, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-local-huys-macbook-pro", "--log-level", "warn",
    ], { cwd: REPO, stdio: "ignore", env: { ...process.env, VELORA_ROOT: REPO } });

    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i += 1) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {}
        await delay(100);
    }

    const version = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });

    let nextId = 1;
    const pending = new Map();
    ws.on("message", (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
        }
    });
    const send = (method, params = {}, sessionId = null) => new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        ws.send(JSON.stringify(payload));
    });

    let sessionId = null;
    let sgssUrl = null;
    let reqHeaders = null;

    try {
        await send("Target.setDiscoverTargets", { discover: true });
        const { targetId } = await send("Target.createTarget", { url: "about:blank" });
        ({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
        await send("Page.enable", {}, sessionId);
        await send("Network.enable", {}, sessionId);

        ws.on("message", (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.method !== "Network.requestWillBeSent" || msg.sessionId !== sessionId) return;
            if (msg.params.type !== "Document") return;
            const url = msg.params.request?.url || "";
            if (url.includes("sg_ss=")) {
                sgssUrl = url;
                reqHeaders = msg.params.request?.headers || {};
            }
        });

        await send("Page.navigate", {
            url: "https://www.google.com/search?q=coingloo.com&hl=vi",
        }, sessionId);

        for (let i = 0; i < 40 && !sgssUrl; i += 1) await delay(250);
    } finally {
        ws.close();
        proc.kill("SIGTERM");
    }

    if (!sgssUrl) {
        console.log("FAIL: no sg_ss URL captured");
        process.exit(1);
    }

    console.log(`captured sg_ss url_len=${sgssUrl.length}`);
    writeFileSync("/tmp/velora-sgss-url.txt", sgssUrl);

    const ref = "https://www.google.com/search?q=coingloo.com";
    const curlArgs = [
        "-sS", "--max-time", "10",
        "-o", "/tmp/velora-sgss-curl.html",
        "-w", "status=%{http_code} time=%{time_total}s proto=%{http_version}\n",
        "-H", `Referer: ${ref}`,
        "-H", "Sec-Fetch-Site: same-origin",
        "-H", "Sec-Fetch-Mode: navigate",
        "-H", "Sec-Fetch-Dest: document",
        sgssUrl,
    ];

    const t0 = Date.now();
    try {
        const meta = execFileSync(CURL, curlArgs, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
        const html = readFileSync("/tmp/velora-sgss-curl.html", "utf8");
        console.log("curl", meta.trim(), `elapsed=${Date.now() - t0}ms`);
        console.log("body", html.length, "serp", /SearchResultsPage/.test(html), "sorry", /\/sorry/.test(html));
    } catch (err) {
        console.log("curl FAILED", err.status, String(err.stderr || err.message).slice(0, 300));
        process.exit(2);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });