#!/usr/bin/env node
/**
 * Phased Google search debug — short timeouts, timestamped milestones.
 * Usage:
 *   node scripts/velora-google-phase-debug.mjs
 *   node scripts/velora-google-phase-debug.mjs --chrome-transport
 *   node scripts/velora-google-phase-debug.mjs --log-level debug
 */

import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = {
        profile: "chrome-local-huys-macbook-pro",
        query: "coingloo.com",
        maxMs: 15000,
        pollMs: 400,
        chromeTransport: false,
        logLevel: "warn",
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--profile") out.profile = argv[++i];
        else if (a === "--query") out.query = argv[++i];
        else if (a === "--max") out.maxMs = Number(argv[++i]);
        else if (a === "--chrome-transport") out.chromeTransport = true;
        else if (a === "--log-level") out.logLevel = argv[++i];
    }
    return out;
}

function ts(t0) {
    return `${Date.now() - t0}ms`;
}

function hopKind(url) {
    if (url.includes("/sorry")) return "sorry";
    if (url.includes("sg_ss=")) return "sg_ss";
    if (url.includes("sei=")) return "sei";
    if (url.includes("/search")) return "search";
    return "other";
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
    close() { this.ws.close(); }
}

async function evalQuick(client, sessionId, expr, timeoutMs = 800) {
    return Promise.race([
        client.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId),
        delay(timeoutMs).then(() => ({ timeout: true })),
    ]);
}

async function main() {
    if (!existsSync(VELORA_BIN)) throw new Error("zig build first");
    const args = parseArgs(process.argv.slice(2));
    const t0 = Date.now();
    const log = (phase, detail = "") => {
        console.log(`[${ts(t0)}] ${phase}${detail ? ` — ${detail}` : ""}`);
    };

    const port = await getFreePort();
    const serveArgs = [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", args.profile, "--log-level", args.logLevel,
    ];
    if (args.chromeTransport) serveArgs.push("--google-chrome-transport");

    const proc = spawn(VELORA_BIN, serveArgs, {
        cwd: REPO,
        stdio: args.logLevel === "debug" ? ["ignore", "pipe", "pipe"] : "ignore",
        env: { ...process.env, VELORA_ROOT: REPO },
    });

    if (args.logLevel === "debug") {
        proc.stderr?.on("data", (buf) => {
            const s = String(buf);
            if (/frame|http|chrome transport|navigate|sg_ss|sei/i.test(s)) {
                process.stderr.write(`[velora] ${s}`);
            }
        });
    }

    const endpoint = `http://127.0.0.1:${port}`;
    log("boot", `port=${port} chromeTransport=${args.chromeTransport}`);
    for (let i = 0; i < 80; i += 1) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {}
        await delay(100);
    }

    const version = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    const client = new CdpClient(ws);

    const milestones = [];
    const byRequestId = new Map();
    const seen = new Set();
    let sessionId = null;
    let navigateSent = false;

    const mark = (name, extra = {}) => {
        const row = { atMs: Date.now() - t0, name, ...extra };
        milestones.push(row);
        log(name, Object.keys(extra).length ? JSON.stringify(extra) : "");
    };

    try {
        await client.send("Target.setDiscoverTargets", { discover: true });
        const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
        ({ sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true }));
        await client.send("Page.enable", {}, sessionId);
        await client.send("Network.enable", {}, sessionId);
        await client.send("Runtime.enable", {}, sessionId);

        client.on("Page.frameNavigated", (params, evSession) => {
            if (evSession && evSession !== sessionId) return;
            const url = params.frame?.url || "";
            if (!url.includes("google.com")) return;
            const kind = hopKind(url);
            const key = `nav:${kind}`;
            if (seen.has(key)) return;
            seen.add(key);
            mark(`frameNavigated:${kind}`, { url: url.slice(0, 120) });
        });

        client.on("Network.requestWillBeSent", (params, evSession) => {
            if (evSession && evSession !== sessionId) return;
            if (params.type !== "Document") return;
            const url = params.request?.url || "";
            if (!url.includes("google.com")) return;
            const kind = hopKind(url);
            const h = params.request?.headers || {};
            const row = {
                kind,
                url: url.slice(0, 160),
                hasSecFetchUser: !!(h["sec-fetch-user"] || h["Sec-Fetch-User"]),
                requestId: params.requestId,
            };
            byRequestId.set(params.requestId, row);
            mark(`docRequest:${kind}`, { requestId: params.requestId });
        });

        client.on("Network.responseReceived", (params, evSession) => {
            if (evSession && evSession !== sessionId) return;
            const row = byRequestId.get(params.requestId);
            if (!row) return;
            row.status = params.response?.status;
            row.protocol = params.response?.protocol;
            mark(`docResponse:${row.kind}`, { status: row.status, protocol: row.protocol });
        });

        client.on("Network.loadingFinished", (params, evSession) => {
            if (evSession && evSession !== sessionId) return;
            const row = byRequestId.get(params.requestId);
            if (!row || row.finished) return;
            row.finished = true;
            mark(`docFinished:${row.kind}`, { status: row.status ?? "?" });
        });

        client.on("Network.loadingFailed", (params, evSession) => {
            if (evSession && evSession !== sessionId) return;
            const row = byRequestId.get(params.requestId);
            if (!row) return;
            mark(`docFailed:${row.kind}`, { error: params.errorText, canceled: params.canceled });
        });

        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(args.query)}&hl=vi`;
        log("navigate", searchUrl.slice(0, 100));
        await client.send("Page.navigate", { url: searchUrl }, sessionId);
        navigateSent = true;
        mark("navigateSent");

        const deadline = Date.now() + args.maxMs;
        let lastProbe = null;
        while (Date.now() < deadline) {
            const probe = await evalQuick(client, sessionId, `({
                href: location.href.slice(0, 140),
                title: document.title.slice(0, 60),
                sorry: location.pathname.includes("/sorry"),
                sei: location.href.includes("sei="),
                sgss: location.href.includes("sg_ss="),
                sgs: typeof window.sgs !== "undefined",
                serp: !!document.getElementById("center_col"),
                hits: document.querySelectorAll("#search .g h3, .MjjYud h3").length,
                ready: document.readyState,
            })`);
            const v = probe?.result?.value;
            if (v && !probe.timeout) {
                lastProbe = v;
                const sig = `${v.ready}|${v.sei}|${v.sgss}|${v.serp}|${v.hits}`;
                if (!seen.has(`probe:${sig}`)) {
                    seen.add(`probe:${sig}`);
                    mark("probe", v);
                }
                if (v.serp || v.hits > 0 || v.sorry) break;
            } else if (probe?.timeout) {
                mark("probeTimeout");
            }

            const sgssReq = [...byRequestId.values()].find((r) => r.kind === "sg_ss");
            if (sgssReq?.finished) break;
            if (sgssReq && !sgssReq.status && Date.now() - t0 > 8000) {
                mark("sg_ss_stall", { waitedMs: Date.now() - t0, url: sgssReq.url?.slice(0, 100) });
                break;
            }
            await delay(args.pollMs);
        }

        const hops = [...byRequestId.values()];
        const sgss = hops.find((h) => h.kind === "sg_ss");
        const report = {
            chromeTransport: args.chromeTransport,
            milestones,
            hops,
            lastProbe,
            diagnosis: !navigateSent ? "navigate_never_sent"
                : !hops.some((h) => h.kind === "search" && h.status) ? "search_no_response"
                : !hops.some((h) => h.kind === "sei" && h.status) ? "sei_no_response"
                : !sgss ? "sg_ss_never_requested"
                : !sgss.status ? "sg_ss_hang_no_response"
                : sgss.status >= 400 ? `sg_ss_http_${sgss.status}`
                : lastProbe?.serp || lastProbe?.hits > 0 ? "serp_ok"
                : "sg_ss_ok_no_serp",
        };

        console.log("\n=== diagnosis ===");
        console.log(report.diagnosis);
        console.log(JSON.stringify(report, null, 2));
        process.exitCode = report.diagnosis === "serp_ok" ? 0 : 1;
    } finally {
        client.close();
        proc.kill("SIGTERM");
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});