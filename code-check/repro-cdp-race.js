#!/usr/bin/env node
// Repro: rapid Page.navigate to amiibo page (which has inline async fetch)
// Goal: capture Velora exit code/signal + last stderr to confirm UAF/crash.

const { spawn } = require("node:child_process");
const { createServer: createHttpServer } = require("node:http");
const { createServer: createNetServer } = require("node:net");
const { createReadStream, statSync, existsSync, writeFileSync, mkdirSync } = require("node:fs");
const { extname, resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const testRoot = resolve(repoRoot, "velora-test");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const outDir = resolve(repoRoot, "code-check/tmp/repro");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const HOST = "127.0.0.1";
const TARGET_PATH = process.argv[2] || "amiibo/00020002.html";
const N = Number(process.argv[3] || 6); // rapid navigations

const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
};

async function getFreePort() {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.unref();
        s.on("error", rej);
        s.listen(0, HOST, () => { const { port } = s.address(); s.close(() => res(port)); });
    });
}

function startStatic(port) {
    const server = createHttpServer((req, res) => {
        const decoded = decodeURIComponent((req.url || "/").split("?")[0]);
        const file = resolve(testRoot, "." + decoded);
        if (!file.startsWith(testRoot) || !existsSync(file) || !statSync(file).isFile()) {
            res.writeHead(404); res.end("404"); return;
        }
        res.writeHead(200, { "content-type": contentTypes[extname(file)] || "application/octet-stream" });
        createReadStream(file).pipe(res);
    });
    return new Promise((res) => server.listen(port, HOST, () => res(server)));
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function waitFor(url, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try { const r = await fetch(url); if (r.ok) return; } catch (_) {}
        await delay(50);
    }
    throw new Error(`waitFor timed out: ${url}`);
}

async function main() {
    const staticPort = await getFreePort();
    const cdpPort = await getFreePort();
    const staticServer = await startStatic(staticPort);
    const baseUrl = `http://${HOST}:${staticPort}`;

    const stderrChunks = [];
    const proc = spawn(veloraBin, [
        "serve", "--host", HOST, "--port", String(cdpPort),
        "--log-level", "debug", "--log-format", "pretty",
        "--http-timeout", "30000",
    ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });

    let procExit = null;
    proc.on("exit", (code, signal) => {
        procExit = { code, signal, at: Date.now() };
        console.log(`\n[velora exit] code=${code} signal=${signal}`);
    });
    proc.stderr.on("data", (c) => stderrChunks.push(c));

    try {
        await waitFor(`http://${HOST}:${cdpPort}/json/version`, 5000);
        const versionRes = await fetch(`http://${HOST}:${cdpPort}/json/version`);
        const { webSocketDebuggerUrl } = await versionRes.json();
        const ws = new WebSocket(webSocketDebuggerUrl);

        const pending = new Map();
        let nextId = 1;
        let wsClosed = false;
        let wsCloseAt = null;
        ws.addEventListener("close", (e) => {
            wsClosed = true;
            wsCloseAt = Date.now();
            console.log(`[ws close] code=${e.code} reason=${e.reason || "(none)"}`);
            for (const p of pending.values()) p.reject(new Error("ws closed"));
            pending.clear();
        });
        ws.addEventListener("error", (e) => {
            console.log(`[ws error]`, e.message || e);
        });
        ws.addEventListener("message", (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id != null && pending.has(m.id)) {
                const p = pending.get(m.id);
                pending.delete(m.id);
                if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
                else p.resolve(m.result || {});
            }
        });
        await new Promise((res, rej) => {
            ws.addEventListener("open", res, { once: true });
            ws.addEventListener("error", rej, { once: true });
        });

        const send = (method, params = {}, sessionId, timeoutMs = 5000) => {
            if (wsClosed) return Promise.reject(new Error(`ws closed before ${method}`));
            const id = nextId++;
            const payload = { id, method, params };
            if (sessionId) payload.sessionId = sessionId;
            return new Promise((res, rej) => {
                const timer = setTimeout(() => {
                    pending.delete(id);
                    rej(new Error(`${method} timed out`));
                }, timeoutMs);
                pending.set(id, {
                    method,
                    resolve: (v) => { clearTimeout(timer); res(v); },
                    reject: (e) => { clearTimeout(timer); rej(e); },
                });
                ws.send(JSON.stringify(payload));
            });
        };

        const { targetId } = await send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
        await send("Runtime.enable", {}, sessionId);
        await send("Page.enable", {}, sessionId);

        const url = `${baseUrl}/${TARGET_PATH.split("/").map(encodeURIComponent).join("/")}`;
        console.log(`[repro] target url: ${url}`);
        console.log(`[repro] sending ${N} rapid Page.navigate`);

        for (let i = 0; i < N; i++) {
            const t0 = Date.now();
            try {
                await send("Page.navigate", { url }, sessionId, 3000);
                await send("Runtime.evaluate", {
                    expression: "document.documentElement && document.documentElement.outerHTML.length",
                    returnByValue: true,
                }, sessionId, 3000);
                console.log(`  iter ${i + 1}: ok in ${Date.now() - t0}ms`);
            } catch (err) {
                console.log(`  iter ${i + 1}: FAIL in ${Date.now() - t0}ms — ${err.message}`);
                if (wsClosed) break;
            }
        }

        // Give Velora a moment to crash/log if it's going to
        if (!wsClosed) await delay(500);
        if (!wsClosed) {
            ws.close();
            console.log("[repro] no ws close detected; closing voluntarily");
        }
    } catch (err) {
        console.error("[repro] error:", err.message);
    } finally {
        await delay(800);
        if (procExit == null) {
            console.log("[repro] velora still running; sending SIGTERM");
            proc.kill("SIGTERM");
            await new Promise((res) => proc.once("exit", res));
        }
        await new Promise((res) => staticServer.close(res));

        const stderr = Buffer.concat(stderrChunks).toString();
        const logPath = resolve(outDir, "repro-velora.log");
        writeFileSync(logPath, stderr);
        console.log(`\n[repro] velora stderr saved: ${logPath} (${stderr.length} bytes)`);

        // Print tail
        const tail = stderr.split("\n").slice(-80).join("\n");
        console.log("\n--- VELORA STDERR (tail 80 lines) ---");
        console.log(tail);
        console.log("--- END ---");
        console.log("[summary]", procExit);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
