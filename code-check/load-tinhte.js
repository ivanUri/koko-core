#!/usr/bin/env node
// Minimal Velora page loader — no probes, no injection.
// Spawns Velora, navigates to TARGET_URL, waits for `Page.loadEventFired`
// (plus a short settle delay so late XHRs/scripts can land in the DOM),
// then saves:
//   <OUT_DIR>/page.html   document.documentElement.outerHTML
//   <OUT_DIR>/page.log    velora stderr captured during the run

const { spawn } = require("node:child_process");
const net = require("node:net");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");

// ---------------------------------------------------------------------------
// CONFIG — edit here, no CLI flags.
// ---------------------------------------------------------------------------
const CONFIG = {
    url: "https://demo.fingerprint.com/playground",
    outDir: resolve(repoRoot, "code-check/tmp/test-creepjs-chrome"),
    htmlFile: "page.html",
    logFile: "page.log",
    // "velora" (default honest profile) or "chrome-macos-catalina" (antidetect)
    browserProfile: "chrome-macos-catalina",
    loadTimeoutMs: 12000,
    settleAfterLoadMs: 20000,
    timeoutMs: 60000,
    logLevel: "info",
};
// ---------------------------------------------------------------------------

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getFreePort() {
    return new Promise((res, rej) => {
        const s = net.createServer();
        s.unref();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
    });
}

async function waitFor(url, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try { const r = await fetch(url); if (r.ok) return; } catch (_) { }
        await delay(50);
    }
    throw new Error(`waitFor timed out: ${url}`);
}

class CdpClient {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        this.eventListeners = new Map();
        this.closed = false;
        ws.addEventListener("close", () => {
            this.closed = true;
            for (const p of this.pending.values()) p.reject(new Error("ws closed"));
            this.pending.clear();
        });
        ws.addEventListener("message", (ev) => this._onMessage(ev));
    }
    _onMessage(ev) {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id != null && this.pending.has(m.id)) {
            const p = this.pending.get(m.id);
            this.pending.delete(m.id);
            if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
            else p.resolve(m.result || {});
            return;
        }
        if (m.method) {
            const key = `${m.method}|${m.sessionId || ""}`;
            const subs = this.eventListeners.get(key);
            if (subs) for (const cb of subs) cb(m.params || {});
        }
    }
    onEvent(method, sessionId, cb) {
        const key = `${method}|${sessionId || ""}`;
        let list = this.eventListeners.get(key);
        if (!list) { list = []; this.eventListeners.set(key, list); }
        list.push(cb);
        return () => {
            const i = list.indexOf(cb);
            if (i >= 0) list.splice(i, 1);
        };
    }
    send(method, params = {}, sessionId, timeoutMs = 30000) {
        if (this.closed) return Promise.reject(new Error(`ws closed before ${method}`));
        const id = this.nextId++;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        return new Promise((res, rej) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                rej(new Error(`${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, {
                method,
                resolve: (v) => { clearTimeout(timer); res(v); },
                reject: (e) => { clearTimeout(timer); rej(e); },
            });
            this.ws.send(JSON.stringify(payload));
        });
    }
}

async function pageEval(client, sessionId, expression, timeoutMs = 15000) {
    const r = await client.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout: timeoutMs,
    }, sessionId, timeoutMs + 1000);
    if (r.exceptionDetails) {
        throw new Error(`eval threw: ${r.exceptionDetails.text || JSON.stringify(r.exceptionDetails)}`);
    }
    return r?.result?.value;
}

async function main() {
    if (!existsSync(veloraBin)) {
        console.error(`velora binary not found: ${veloraBin}`);
        console.error("build first: zig build -Doptimize=ReleaseFast");
        process.exit(1);
    }
    if (!existsSync(CONFIG.outDir)) mkdirSync(CONFIG.outDir, { recursive: true });

    const htmlPath = resolve(CONFIG.outDir, CONFIG.htmlFile);
    const logPath = resolve(CONFIG.outDir, CONFIG.logFile);

    const port = await getFreePort();
    const veloraArgs = [
        "serve",
        "--host", "127.0.0.1",
        "--port", String(port),
        "--log-level", CONFIG.logLevel,
        "--log-format", "pretty",
        "--http-timeout", String(CONFIG.timeoutMs),
    ];
    if (CONFIG.browserProfile) {
        veloraArgs.push("--browser-profile", CONFIG.browserProfile);
    }
    console.log(`[velora] launching ${veloraBin}`);
    console.log(`[velora]   args=${veloraArgs.join(" ")}`);
    console.log(`[velora]   url=${CONFIG.url}`);

    const stderrChunks = [];
    const proc = spawn(veloraBin, veloraArgs, {
        cwd: repoRoot,
        stdio: ["ignore", "ignore", "pipe"],
    });
    let exited = null;
    proc.on("exit", (code, signal) => {
        exited = { code, signal };
        console.log(`\n[velora exit] code=${code} signal=${signal}`);
    });
    proc.stderr.on("data", (c) => stderrChunks.push(c));

    const flushLog = () => {
        try {
            writeFileSync(logPath, Buffer.concat(stderrChunks).toString());
        } catch (e) {
            console.error(`[velora] failed to write log: ${e.message}`);
        }
    };

    const cleanup = async () => {
        flushLog();
        console.log(`[velora] log saved: ${logPath}`);
        if (!exited) {
            proc.kill("SIGTERM");
            await new Promise((r) => proc.once("exit", r));
        }
    };

    let ws;
    try {
        await waitFor(`http://127.0.0.1:${port}/json/version`, 5000);
        const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
            ws.addEventListener("open", res, { once: true });
            ws.addEventListener("error", rej, { once: true });
        });
        const client = new CdpClient(ws);

        const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
        await client.send("Page.enable", {}, sessionId);
        await client.send("Runtime.enable", {}, sessionId);

        const loadOnce = new Promise((res) => {
            const off = client.onEvent("Page.loadEventFired", sessionId, () => { off(); res(); });
        });

        console.log(`[load] navigating to ${CONFIG.url}`);
        const t0 = Date.now();
        const nav = await client.send("Page.navigate", { url: CONFIG.url }, sessionId, CONFIG.timeoutMs);
        if (nav.errorText) throw new Error(`navigate error: ${nav.errorText}`);

        await Promise.race([
            loadOnce,
            delay(CONFIG.loadTimeoutMs).then(() => console.log(`[load] WARNING: load event did not fire within ${CONFIG.loadTimeoutMs}ms`)),
        ]);
        console.log(`[load] load fired in ${Date.now() - t0}ms; settling for ${CONFIG.settleAfterLoadMs}ms…`);
        await delay(CONFIG.settleAfterLoadMs);

        let html = "";
        try {
            const v = await pageEval(client, sessionId,
                "document.documentElement && document.documentElement.outerHTML", 15000);
            if (typeof v === "string") html = v;
        } catch (e) {
            console.log(`[load] html extraction failed: ${e.message}`);
        }

        writeFileSync(htmlPath, html);

        let title = null;
        try {
            title = await pageEval(client, sessionId, "document.title", 5000);
        } catch (_) { }

        console.log("\n=== load summary ===");
        console.log(`url:        ${CONFIG.url}`);
        console.log(`title:      ${title ?? "(none)"}`);
        console.log(`html bytes: ${html.length}`);
        console.log(`html saved: ${htmlPath}`);
        console.log(`log saved:  ${logPath}`);
    } catch (err) {
        console.error("[load] error:", err.message);
        process.exitCode = 1;
    } finally {
        try { ws && ws.close(); } catch (_) { }
        await cleanup();
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
