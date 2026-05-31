#!/usr/bin/env node
// Runs Velora with VELORA_JS_CALL_LOG=1 against a real page URL.

const { spawn } = require("node:child_process");
const http = require("node:http");
const net = require("node:net");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const outDir = resolve(repoRoot, "code-check/tmp/js-call-log-demo");
const logPath = resolve(outDir, "velora.log");
const defaultUrl = "https://abrahamjuliot.github.io/creepjs/";
const url = process.argv[2] || defaultUrl;

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getFreePort() {
    return new Promise((resolvePort, reject) => {
        const server = net.createServer();
        server.unref();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            server.close(() => resolvePort(port));
        });
    });
}

async function waitFor(url, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch (_) {}
        await delay(50);
    }
    throw new Error(`Timed out waiting for ${url}`);
}

class CdpClient {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        this.events = new Map();
        ws.addEventListener("message", (event) => this.onMessage(event));
        ws.addEventListener("close", () => {
            for (const pending of this.pending.values()) pending.reject(new Error("WebSocket closed"));
            this.pending.clear();
        });
    }

    onMessage(event) {
        let message;
        try { message = JSON.parse(event.data); } catch (_) { return; }
        if (message.id != null && this.pending.has(message.id)) {
            const pending = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
            else pending.resolve(message.result || {});
            return;
        }
        const key = `${message.method || ""}|${message.sessionId || ""}`;
        for (const listener of this.events.get(key) || []) listener(message.params || {});
    }

    on(method, sessionId, callback) {
        const key = `${method}|${sessionId || ""}`;
        const listeners = this.events.get(key) || [];
        listeners.push(callback);
        this.events.set(key, listeners);
        return () => {
            const index = listeners.indexOf(callback);
            if (index >= 0) listeners.splice(index, 1);
        };
    }

    send(method, params = {}, sessionId, timeoutMs = 10000) {
        const id = this.nextId++;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        return new Promise((resolveRequest, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out`));
            }, timeoutMs);
            this.pending.set(id, {
                method,
                resolve: (value) => { clearTimeout(timer); resolveRequest(value); },
                reject: (error) => { clearTimeout(timer); reject(error); },
            });
            this.ws.send(JSON.stringify(payload));
        });
    }
}

async function main() {
    if (!existsSync(veloraBin)) throw new Error(`Missing ${veloraBin}; run zig build first`);
    mkdirSync(outDir, { recursive: true });

    const cdpPort = await getFreePort();
    const stderrChunks = [];
    const velora = spawn(veloraBin, [
        "serve",
        "--host", "127.0.0.1",
        "--port", String(cdpPort),
        "--log-level", "info",
        "--log-format", "pretty",
    ], {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, VELORA_JS_CALL_LOG: "1" },
    });
    velora.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    let ws;
    try {
        await waitFor(`http://127.0.0.1:${cdpPort}/json/version`, 5000);
        const version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
        ws = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((resolveWs, reject) => {
            ws.addEventListener("open", resolveWs, { once: true });
            ws.addEventListener("error", reject, { once: true });
        });

        const client = new CdpClient(ws);
        const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
        await client.send("Page.enable", {}, sessionId);
        await client.send("Runtime.enable", {}, sessionId);

        client.on("Runtime.consoleAPICalled", sessionId, (params) => {
            const values = (params.args || []).map((arg) => arg.value ?? arg.description ?? "");
            console.log("[console]", ...values);
        });

        const loaded = new Promise((resolveLoad) => {
            const off = client.on("Page.loadEventFired", sessionId, () => { off(); resolveLoad(); });
        });

        console.log(`[demo] VELORA_JS_CALL_LOG=1 ${veloraBin} serve ...`);
        console.log(`[demo] navigating to ${url}`);
        await client.send("Page.navigate", { url }, sessionId);
        await loaded;
        await delay(5000);
    } finally {
        try { ws && ws.close(); } catch (_) {}
        velora.kill("SIGTERM");
        const logContent = Buffer.concat(stderrChunks).toString();
        writeFileSync(logPath, logContent);
        console.log(`[demo] velora log saved: ${logPath}`);

        const callLines = logContent.split("\n").filter((line) => line.includes("[velora-js-call]") || line.includes("script call log source"));
        console.log(`[demo] matched ${callLines.length} JS call-log lines`);
        for (const line of callLines.slice(0, 40)) console.log(line);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
