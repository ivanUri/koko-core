#!/usr/bin/env node
/** Velora native transport — capture document hop headers (sec-fetch-user check). */

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
    const out = { profile: "chrome-local-huys-macbook-pro", query: "coingloo.com", settleMs: 12000 };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--profile") out.profile = argv[++i];
        else if (argv[i] === "--query") out.query = argv[++i];
        else if (argv[i] === "--settle") out.settleMs = Number(argv[++i]);
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

function hopKind(url) {
    if (url.includes("/sorry")) return "sorry";
    if (url.includes("sg_ss=")) return "sg_ss";
    if (url.includes("sei=")) return "sei";
    if (url.includes("/search")) return "search";
    return "other";
}

async function main() {
    if (!existsSync(VELORA_BIN)) throw new Error("zig build first");
    const args = parseArgs(process.argv.slice(2));
    const port = await getFreePort();
    const proc = spawn(VELORA_BIN, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", args.profile, "--log-level", "warn",
    ], { cwd: REPO, stdio: "ignore", env: { ...process.env, VELORA_ROOT: REPO } });

    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 80; i += 1) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {}
        await delay(100);
    }

    const version = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    const client = new CdpClient(ws);

    const docs = [];
    const byRequestId = new Map();
    let sessionId = null;

    try {
        await client.send("Target.setDiscoverTargets", { discover: true });
        const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
        ({ sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true }));
        await client.send("Page.enable", {}, sessionId);
        await client.send("Network.enable", {}, sessionId);

        client.on("Network.requestWillBeSent", (params, evSession) => {
            if (evSession && evSession !== sessionId) return;
            if (params.type !== "Document") return;
            const url = params.request?.url || "";
            if (!url.includes("google.com")) return;
            const h = params.request?.headers || {};
            const row = {
                kind: hopKind(url),
                url: url.slice(0, 160),
                hasSecFetchUser: !!(h["sec-fetch-user"] || h["Sec-Fetch-User"]),
                secFetchSite: h["sec-fetch-site"] || h["Sec-Fetch-Site"] || null,
                cookieLen: (h.Cookie || h.cookie || "").length,
            };
            docs.push(row);
            byRequestId.set(params.requestId, row);
        });

        client.on("Network.responseReceived", (params, evSession) => {
            if (evSession && evSession !== sessionId) return;
            const row = byRequestId.get(params.requestId);
            if (!row) return;
            row.status = params.response?.status;
            row.protocol = params.response?.protocol;
            row.finalUrl = (params.response?.url || "").slice(0, 160);
        });

        client.on("Network.loadingFinished", async (params, evSession) => {
            if (evSession && evSession !== sessionId) return;
            const row = byRequestId.get(params.requestId);
            if (!row || row.bodyChecked) return;
            row.bodyChecked = true;
            if (row.kind !== "sg_ss" && row.kind !== "sei") return;
            try {
                const body = await client.send("Network.getResponseBody", {
                    requestId: params.requestId,
                }, sessionId);
                const html = body.base64Encoded
                    ? Buffer.from(body.body, "base64").toString("utf8")
                    : body.body;
                row.sorryBody = /\/sorry|unusual traffic/i.test(html);
                row.serpBody = /id="center_col"|SearchResultsPage/.test(html);
            } catch {}
        });

        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(args.query)}&hl=vi`;
        await client.send("Page.navigate", { url: searchUrl }, sessionId);
        await delay(args.settleMs);

        await delay(3000);

        const evalResult = await Promise.race([
            client.send("Runtime.evaluate", {
                expression: `({ url: location.href, title: document.title, sorry: location.pathname.includes("/sorry"), center: !!document.getElementById("center_col") })`,
                returnByValue: true,
            }, sessionId),
            delay(5000).then(() => null),
        ]);

        const probe = evalResult?.result?.value ?? null;
        const inSessionHops = docs.filter((d) => d.kind === "sei" || d.kind === "sg_ss");
        const sfuLeak = inSessionHops.some((d) => d.hasSecFetchUser);
        const sgss = docs.find((d) => d.kind === "sg_ss");
        const networkSorry = sgss?.sorryBody === true || sgss?.status === 302 || sgss?.status === 429
            || docs.some((d) => d.kind === "sorry");

        const pass = !sfuLeak && !networkSorry && (probe?.center === true || sgss?.serpBody === true);

        const report = {
            probe,
            hops: docs,
            sfuLeak,
            networkSorry,
            pass,
        };
        console.log(JSON.stringify(report, null, 2));

        console.log("\n--- velora wire hops ---");
        for (const h of docs) {
            console.log(`${h.kind} ${h.status ?? "?"} ${h.hasSecFetchUser ? "LEAK-sfu" : "no-sfu"} ${h.url}`);
        }
        console.log(`\n${report.pass ? "PASS" : "FAIL"}  networkSorry=${networkSorry}  sfuLeak=${sfuLeak}  probe=${JSON.stringify(probe)}`);

        process.exitCode = report.pass ? 0 : 1;
    } finally {
        client.close();
        proc.kill("SIGTERM");
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});