#!/usr/bin/env node
// Repro for the "Fetch domain frame race" referenced by the TODO at
// src/protocols/cdp/domains/fetch.zig:199 and :422.
//
// Scenario:
//   1. Enable Fetch.enable so HTTP requests get paused and forwarded to us.
//   2. Page.navigate to amiibo/00020002.html. The page's inline script does
//      `fetch('00020002.json')`. Velora pauses that fetch and emits
//      Fetch.requestPaused; we deliberately *do not* answer it.
//   3. Page.navigate to a different URL (cache.html). Velora tears down the
//      old frame: Frame.deinit aborts in-flight transfers, the per-frame
//      arena is released back to the pool, and that arena is the one that
//      backs `request.params.arena` for the still-pending intercept entry
//      stored in `bc.intercept_state.waiting`.
//   4. Send Fetch.continueRequest for the OLD requestId. continueRequest
//      pulls the entry out of `waiting`, accesses `request.params.arena`
//      (now dangling) for `arena.dupeZ`, and forwards the Request struct
//      into HttpClient.interception_layer.continueRequest with frame_id
//      pointing to the dead frame.
//
// Expected before-fix:
//   - Velora segfaults, OR
//   - Strange data corruption (request goes through with garbage URL/headers
//     because the arena memory has been reused by the new frame).
//
// Expected after-fix:
//   - continueRequest returns a clean CDP error (e.g. "request frame gone")
//     and the in-flight stale transfer is dropped.
//
// This script does NOT need access to a real Wikipedia / external URL — it
// uses the local amiibo fixture which already has the right shape (an inline
// script that calls fetch()).

const { spawn } = require("node:child_process");
const { createServer: createHttpServer } = require("node:http");
const { createServer: createNetServer } = require("node:net");
const { createReadStream, statSync, existsSync, writeFileSync, mkdirSync } = require("node:fs");
const { extname, resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const testRoot = resolve(repoRoot, "velora-test");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const outDir = resolve(repoRoot, "code-check/tmp/repro-fetch-frame-race");
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

const HOST = "127.0.0.1";

const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
};

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
        "--log-level", "info", "--log-format", "pretty",
        "--http-timeout", "30000",
    ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });

    let procExit = null;
    proc.on("exit", (code, signal) => {
        procExit = { code, signal };
        console.log(`\n[velora exit] code=${code} signal=${signal}`);
    });
    proc.stderr.on("data", (c) => stderrChunks.push(c));

    try {
        await waitFor(`http://${HOST}:${cdpPort}/json/version`, 5000);
        const v = await (await fetch(`http://${HOST}:${cdpPort}/json/version`)).json();
        const ws = new WebSocket(v.webSocketDebuggerUrl);

        const pending = new Map();
        let nextId = 1;
        let wsClosed = false;
        const pausedRequests = []; // { requestId, frameId, url }

        ws.addEventListener("close", (e) => {
            wsClosed = true;
            console.log(`[ws close] code=${e.code} reason=${e.reason || "(none)"}`);
            for (const p of pending.values()) p.reject(new Error("ws closed"));
            pending.clear();
        });
        ws.addEventListener("message", (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id != null && pending.has(m.id)) {
                const p = pending.get(m.id);
                pending.delete(m.id);
                if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
                else p.resolve(m.result || {});
                return;
            }
            if (m.method === "Fetch.requestPaused") {
                pausedRequests.push({
                    requestId: m.params.requestId,
                    frameId: m.params.frameId,
                    url: m.params.request?.url,
                    sessionId: m.sessionId,
                });
                console.log(`[fetch] paused requestId=${m.params.requestId} url=${m.params.request?.url}`);
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

        // Enable Fetch interception for *all* requests so the inline
        // amiibo `fetch('00020002.json')` gets paused and parked in
        // bc.intercept_state.waiting on the velora side.
        await send("Fetch.enable", {
            patterns: [{ urlPattern: "*", requestStage: "Request" }],
            handleAuthRequests: false,
        }, sessionId);
        console.log("[step] Fetch.enable OK — all requests will be paused");

        const urlA = `${baseUrl}/amiibo/00020002.html`;
        const urlB = `${baseUrl}/cache.html`; // any other page

        // Step 1: navigate to A. We need to *answer* its document request
        // (otherwise the page never loads its inline script that issues the
        // JSON fetch). The strategy: continue every paused request EXCEPT
        // the one whose URL ends with .json — we hold that one back.
        //
        // We do this by polling pausedRequests and continueRequest'ing
        // anything we don't want to keep parked.
        const heldBack = new Set();
        let stopWatcher = false;
        const watcher = (async () => {
            let cursor = 0;
            while (!stopWatcher) {
                while (cursor < pausedRequests.length) {
                    const r = pausedRequests[cursor++];
                    if (r.url && r.url.endsWith(".json")) {
                        heldBack.add(r.requestId);
                        console.log(`[step] HOLDING json request ${r.requestId} (frameId=${r.frameId})`);
                        continue;
                    }
                    try {
                        await send("Fetch.continueRequest", { requestId: r.requestId }, sessionId, 3000);
                    } catch (err) {
                        console.log(`[continue] ${r.requestId} failed: ${err.message}`);
                    }
                }
                await delay(20);
            }
        })();

        console.log(`[step] navigate A: ${urlA}`);
        await send("Page.navigate", { url: urlA }, sessionId, 5000);

        // Wait for the .json fetch to be paused.
        const start = Date.now();
        while (heldBack.size === 0 && Date.now() - start < 5000) await delay(50);
        if (heldBack.size === 0) {
            console.log("[warn] no .json request was paused — repro precondition failed");
        } else {
            console.log(`[step] held back ${heldBack.size} request(s); now navigating away to tear the frame down`);
        }

        // Step 2: navigate to B. The active frame (frame_id N) gets torn down
        // by Session.commitPendingPage / Session.destroyPage / Frame.deinit.
        // Frame.deinit aborts in-flight transfers and releases the per-frame
        // arena. The held-back json request still lives in
        // bc.intercept_state.waiting; its `request.params.arena` is now
        // dangling, and its frame_id refers to a dead frame.
        console.log(`[step] navigate B: ${urlB}`);
        await send("Page.navigate", { url: urlB }, sessionId, 5000);

        // Give velora a moment to fully tear down frame A.
        await delay(300);

        // Step 3: try to continue the OLD (frame-A) intercepted request.
        // This is the moment the TODO at fetch.zig:199 / :422 warns about.
        // continueRequest will:
        //   - intercept_state.remove(reqId)  -> returns Pending{ .request }
        //   - read request.params.arena  -> dangling Allocator
        //   - call arena.dupeZ if user passed url override / headers
        //   - hand the Request to HttpClient.interception_layer.continueRequest
        //     which submits a transfer for frame_id of the dead frame.
        for (const reqId of heldBack) {
            console.log(`[step] continueRequest for STALE ${reqId} …`);
            try {
                // Pass headers/url overrides so the buggy path actually
                // touches request.params.arena.dupeZ.
                const res = await send("Fetch.continueRequest", {
                    requestId: reqId,
                    url: `${baseUrl}/amiibo/00020002.json?stale=1`,
                    headers: [{ name: "X-Stale-Probe", value: "1" }],
                }, sessionId, 3000);
                console.log(`  → returned: ${JSON.stringify(res)}`);
            } catch (err) {
                console.log(`  → error: ${err.message}`);
                if (wsClosed) break;
            }
        }

        // Allow any deferred crash to surface.
        await delay(500);
        stopWatcher = true;
        await watcher;

        if (!wsClosed) {
            try { ws.close(); } catch (_) {}
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
        const logPath = resolve(outDir, "velora.log");
        writeFileSync(logPath, stderr);
        console.log(`\n[repro] velora stderr saved: ${logPath} (${stderr.length} bytes)`);
        console.log("[summary]", procExit);

        const crashed = procExit && (procExit.signal || procExit.code !== 0 && procExit.code !== null);
        console.log(`\nVERDICT: ${crashed ? "CRASH (frame race confirmed)" : "no crash on this run"}`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
