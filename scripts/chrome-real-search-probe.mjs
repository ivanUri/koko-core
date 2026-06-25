#!/usr/bin/env node
/**
 * Google search ground-truth via REAL Chrome (Google Chrome.app), raw CDP only.
 * No Playwright, no Chromium, no @velora/sdk.
 *
 * Usage:
 *   node scripts/chrome-real-search-probe.mjs
 *   node scripts/chrome-real-search-probe.mjs --query coingloo.com --guest
 *   node scripts/chrome-real-search-probe.mjs --endpoint http://127.0.0.1:9222
 */

import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHROME_BIN = process.env.CHROME_BIN
    || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = {
        query: "coingloo.com",
        guest: false,
        incognito: false,
        endpoint: null,
        port: null,
        settleMs: 6000,
        keep: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--query") out.query = argv[++i];
        else if (a === "--guest") out.guest = true;
        else if (a === "--incognito") out.incognito = true;
        else if (a === "--endpoint") out.endpoint = argv[++i];
        else if (a === "--port") out.port = Number(argv[++i]);
        else if (a === "--settle") out.settleMs = Number(argv[++i]);
        else if (a === "--keep") out.keep = true;
    }
    return out;
}

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

async function cdpReady(endpoint) {
    try {
        return (await fetch(`${endpoint}/json/version`)).ok;
    } catch {
        return false;
    }
}

async function spawnRealChrome(opts) {
    const port = opts.port ?? await getFreePort();
    const endpoint = `http://127.0.0.1:${port}`;
    const profileDir = `/tmp/velora-real-chrome-${port}`;
    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
    ];
    if (opts.guest) args.push("--guest");
    if (opts.incognito) args.push("--incognito");
    if (opts.startUrl) args.push(String(opts.startUrl));

    const proc = spawn(CHROME_BIN, args, { stdio: "ignore", detached: true });
    proc.unref();

    for (let i = 0; i < 80; i += 1) {
        if (await cdpReady(endpoint)) return { proc, endpoint, port, profileDir };
        await delay(150);
    }
    throw new Error(`Real Chrome CDP not ready: ${endpoint}\nBin: ${CHROME_BIN}`);
}

class CdpClient {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        this.events = new Map();
        ws.on("message", (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                else resolve(msg.result);
                return;
            }
            if (msg.method) {
                const handlers = this.events.get(msg.method);
                if (handlers) for (const h of handlers) h(msg.params, msg.sessionId);
            }
        });
    }

    on(method, handler) {
        if (!this.events.has(method)) this.events.set(method, []);
        this.events.get(method).push(handler);
    }

    send(method, params = {}, sessionId = null) {
        const id = this.nextId++;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(payload));
        });
    }

    close() {
        this.ws.close();
    }
}

function classifyUrl(url) {
    if (url.includes("/sorry")) return "sorry";
    if (url.includes("sg_ss=")) return "sg_ss";
    if (url.includes("sei=")) return "sei";
    if (url.includes("/search")) return "search";
    return "other";
}

function classifyHtml(html) {
    const h = String(html || "");
    return {
        sorry: /\/sorry|unusual traffic/i.test(h),
        serp: /id="center_col"|SearchResultsPage/.test(h),
        title: (h.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.slice(0, 100) ?? null,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    let chromeProc = null;
    let endpoint = args.endpoint?.replace(/\/$/, "") ?? null;

    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(args.query)}&hl=vi`;

    if (!endpoint) {
        const port = args.port ?? await getFreePort();
        ({ proc: chromeProc, endpoint } = await spawnRealChrome({
            port,
            guest: args.guest,
            incognito: args.incognito,
            startUrl: args.guest ? searchUrl : null,
        }));
    } else if (!(await cdpReady(endpoint))) {
        throw new Error(`Chrome CDP not reachable: ${endpoint}`);
    }

    const version = await (await fetch(`${endpoint}/json/version`)).json();
    console.log(`chrome: ${version.Browser || version.browser} @ ${endpoint}`);
    console.log(`mode: ${args.guest ? "guest" : args.incognito ? "incognito" : "fresh-profile"}`);

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    const client = new CdpClient(ws);

    const docs = [];
    let sessionId = null;

    try {
        await client.send("Target.setDiscoverTargets", { discover: true });

        let targetId = null;
        let attachedExisting = false;
        for (let i = 0; i < 40; i += 1) {
            const targets = await (await fetch(`${endpoint}/json/list`)).json();
            const page = targets.find((t) => t.type === "page" && !t.url.startsWith("chrome://"));
            if (page) {
                targetId = page.id;
                attachedExisting = true;
                break;
            }
            await delay(200);
        }
        if (!targetId) {
            ({ targetId } = await client.send("Target.createTarget", { url: "about:blank" }));
        }

        ({ sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true }));
        await client.send("Page.enable", {}, sessionId);
        await client.send("Network.enable", {}, sessionId);

        client.on("Network.requestWillBeSent", (params, evSession) => {
            if (evSession && evSession !== sessionId) return;
            if (params.type !== "Document") return;
            const url = params.request?.url || "";
            if (!url.includes("google.com")) return;
            const h = params.request?.headers || {};
            docs.push({
                kind: classifyUrl(url),
                url: url.slice(0, 140),
                hasSecFetchUser: !!(h["sec-fetch-user"] || h["Sec-Fetch-User"]),
                secFetchSite: h["sec-fetch-site"] || h["Sec-Fetch-Site"] || null,
                cookieLen: (h.Cookie || h.cookie || "").length,
            });
        });

        client.on("Network.responseReceived", (params, evSession) => {
            if (evSession && evSession !== sessionId) return;
            if (params.type !== "Document") return;
            const url = params.request?.url || "";
            if (!url.includes("google.com")) return;
            const row = docs.find((d) => d.url === url.slice(0, 140)) ?? docs[docs.length - 1];
            if (row) {
                row.status = params.response?.status;
                row.protocol = params.response?.protocol;
            }
        });

        if (!attachedExisting || !args.guest) {
            await client.send("Page.navigate", { url: searchUrl }, sessionId);
        }
        await delay(args.settleMs);

        const evalResult = await client.send("Runtime.evaluate", {
            expression: `({ url: location.href, title: document.title, sorry: location.pathname.includes("/sorry"), center: !!document.getElementById("center_col") })`,
            returnByValue: true,
        }, sessionId);

        const probe = evalResult.result?.value ?? {};
        const report = {
            query: args.query,
            probe,
            hops: docs,
            pass: !probe.sorry && probe.center,
        };
        console.log(JSON.stringify(report, null, 2));

        console.log("\n--- real chrome hops ---");
        for (const h of docs) {
            console.log(`${h.kind} ${h.status ?? "?"} ${h.hasSecFetchUser ? "sec-fetch-user" : "no-sfu"} ${h.url}`);
        }
        console.log(`\n${report.pass ? "PASS" : "FAIL"}  sorry=${probe.sorry}  center_col=${probe.center}  title=${probe.title}`);

        process.exitCode = report.pass ? 0 : 1;
    } finally {
        client.close();
        if (chromeProc && !args.keep) {
            try { process.kill(-chromeProc.pid, "SIGTERM"); } catch {
                try { chromeProc.kill("SIGTERM"); } catch {}
            }
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});