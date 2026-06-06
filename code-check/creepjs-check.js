#!/usr/bin/env node
// Run a CreepJS fingerprint check (https://abrahamjuliot.github.io/creepjs/)
// against the local Velora build via CDP.
//
// Configuration is hard-coded in the CONFIG block below — no CLI args.
// Outputs (always written, each in its own file):
//   <OUT_DIR>/creepjs.html   full document.documentElement.outerHTML
//   <OUT_DIR>/creepjs.log    velora stderr captured during the run
//   <OUT_DIR>/creepjs.json   parsed summary + last DOM probe

const { spawn } = require("node:child_process");
const net = require("node:net");
const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");

// ---------------------------------------------------------------------------
// CONFIG — edit here, no CLI flags.
// ---------------------------------------------------------------------------

//importain URL_JS_CHECK:https://abrahamjuliot.github.io/creepjs/creep.js 
const CONFIG = {
    url: "https://abrahamjuliot.github.io/creepjs/",
    outDir: resolve(repoRoot, "code-check/tmp/creepjs"),
    htmlFile: "creepjs.html",
    logFile: "creepjs.log",
    jsonFile: "creepjs.json",
    // Overall budget for the fingerprint to settle (CreepJS spins for ~5–20s).
    settleTimeoutMs: 60000,
    // Per-CDP-call timeout / velora http-timeout.
    timeoutMs: 30000,
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
        try { const r = await fetch(url); if (r.ok) return; } catch (_) {}
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

// CreepJS is fully client-side: it spins for several seconds computing the
// fingerprint, then renders #fingerprint-data + #fuzzy-fingerprint .unblurred.
// The .trust-score-container widget depends on a backend POST that often
// never resolves under Velora, so we poll for the local fingerprint sections
// instead — that is enough to know "compute is done".
const READY_PROBE = `(async () => {
  const grab = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.textContent.trim() : null;
  };
  const fpData = document.querySelector("#fingerprint-data");
  const fpDataLen = fpData ? fpData.textContent.trim().length : 0;
  const fuzzyText = grab("#fuzzy-fingerprint .unblurred");
  const trustText =
    grab(".trust-score-container") ||
    grab(".unblurred .trust-score-container") ||
    grab("[id*=trust-score]");
  const fpIdText =
    grab("#fingerprint-data .fingerprint .visitor-id") ||
    grab(".fingerprint .visitor-id") ||
    grab("#creep-fingerprint .visitor-id") ||
    grab(".visitor-id");
  const creepIdText =
    grab(".creep-id") ||
    grab(".creep .visitor-id");
  // Ready = local compute finished. Trust score widget is best-effort only.
  const ready = fpDataLen > 200 && !!fuzzyText && /[0-9a-f]{8,}/i.test(fuzzyText);
  return { ready, fpDataLen, fuzzyText, trustText, fpIdText, creepIdText };
})()`;

const SUMMARY_PROBE = `(() => {
  const text = (sel) => {
    const el = document.querySelector(sel);
    return el ? el.textContent.replace(/\\s+/g, ' ').trim() : null;
  };
  const all = (sel) => Array.from(document.querySelectorAll(sel))
    .map((el) => el.textContent.replace(/\\s+/g, ' ').trim());
  const pickNum = (s) => {
    if (!s) return null;
    const m = s.match(/(-?\\d+(?:\\.\\d+)?)/);
    return m ? Number(m[1]) : null;
  };
  const trust = text(".trust-score-container");
  const lies = all(".lies-len, .lies, .lies-list").join(" | ");
  const bot = all(".bot-detection, .bot, [class*=headless]").join(" | ");
  return {
    url: location.href,
    title: document.title,
    trustScoreText: trust,
    trustScorePct: pickNum(trust),
    fingerprintId:
      text("#fingerprint-data .fingerprint .visitor-id") ||
      text(".fingerprint .visitor-id") ||
      text(".visitor-id"),
    creepId: text(".creep-id") || text(".creep .visitor-id"),
    liesSummary: lies || null,
    botSummary: bot || null,
    userAgent: navigator.userAgent,
    webdriver: navigator.webdriver === true,
    languages: navigator.languages,
    platform: navigator.platform,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio },
  };
})()`;

async function main() {
    if (!existsSync(veloraBin)) {
        console.error(`velora binary not found: ${veloraBin}`);
        console.error("build first: zig build -Doptimize=ReleaseFast -Dsnapshot_path=../../snapshot.bin");
        process.exit(1);
    }
    if (!existsSync(CONFIG.outDir)) mkdirSync(CONFIG.outDir, { recursive: true });

    const htmlPath = resolve(CONFIG.outDir, CONFIG.htmlFile);
    const logPath = resolve(CONFIG.outDir, CONFIG.logFile);
    const jsonPath = resolve(CONFIG.outDir, CONFIG.jsonFile);

    const port = await getFreePort();
    const veloraArgs = [
        "serve",
        "--host", "127.0.0.1",
        "--port", String(port),
        "--log-level", CONFIG.logLevel,
        "--log-format", "pretty",
        "--http-timeout", String(CONFIG.timeoutMs),
    ];
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

        console.log(`[creepjs] navigating…`);
        const t0 = Date.now();
        const nav = await client.send("Page.navigate", { url: CONFIG.url }, sessionId, CONFIG.timeoutMs);
        if (nav.errorText) throw new Error(`navigate error: ${nav.errorText}`);
        await Promise.race([loadOnce, delay(Math.min(CONFIG.timeoutMs, 15000))]);
        console.log(`[creepjs] page load fired in ${Date.now() - t0}ms; waiting for fingerprint to settle…`);

        const pollDeadline = Date.now() + CONFIG.settleTimeoutMs;
        let lastProbe = null;
        let ready = false;
        while (Date.now() < pollDeadline) {
            try {
                lastProbe = await pageEval(client, sessionId, READY_PROBE, 10000);
                if (lastProbe && lastProbe.ready) { ready = true; break; }
            } catch (e) {
                console.log(`  poll error: ${e.message}`);
            }
            await delay(500);
        }
        const settleMs = Date.now() - t0;
        if (!ready) {
            console.log(`[creepjs] WARNING: fingerprint did not settle within ${CONFIG.settleTimeoutMs}ms`);
            console.log(`[creepjs] last probe: ${JSON.stringify(lastProbe)}`);
        } else {
            console.log(`[creepjs] fingerprint settled in ${settleMs}ms`);
        }

        await delay(1000);

        let summary = null;
        try {
            summary = await pageEval(client, sessionId, SUMMARY_PROBE, 15000);
        } catch (e) {
            console.log(`[creepjs] summary probe failed: ${e.message}`);
        }
        let html = "";
        try {
            const v = await pageEval(client, sessionId,
                "document.documentElement && document.documentElement.outerHTML", 15000);
            if (typeof v === "string") html = v;
        } catch (e) {
            console.log(`[creepjs] html extraction failed: ${e.message}`);
        }

        // Fix relative CSS path to absolute CDN URL for offline viewing
        html = html.replace(
            /href="style\.min\.css"/g,
            'href="https://abrahamjuliot.github.io/creepjs/style.min.css"'
        );

        writeFileSync(htmlPath, html);
        writeFileSync(jsonPath, JSON.stringify({
            generated_at: new Date().toISOString(),
            engine: "velora",
            velora_bin: veloraBin,
            url: CONFIG.url,
            settled: ready,
            settle_ms: settleMs,
            settle_timeout_ms: CONFIG.settleTimeoutMs,
            html_bytes: html.length,
            html_file: htmlPath,
            log_file: logPath,
            summary,
            last_probe: lastProbe,
        }, null, 2));

        console.log("\n=== creepjs summary ===");
        console.log(`url:           ${summary?.url ?? CONFIG.url}`);
        console.log(`title:         ${summary?.title ?? "(none)"}`);
        console.log(`trust score:   ${summary?.trustScoreText ?? "(none)"} (parsed: ${summary?.trustScorePct ?? "n/a"})`);
        console.log(`fingerprint:   ${summary?.fingerprintId ?? "(none)"}`);
        console.log(`creep id:      ${summary?.creepId ?? "(none)"}`);
        console.log(`webdriver:     ${summary?.webdriver}`);
        console.log(`user-agent:    ${summary?.userAgent ?? "(none)"}`);
        console.log(`platform:      ${summary?.platform ?? "(none)"}`);
        console.log(`languages:     ${JSON.stringify(summary?.languages)}`);
        console.log(`timezone:      ${summary?.timezone ?? "(none)"}`);
        console.log(`screen:        ${JSON.stringify(summary?.screen)}`);
        console.log(`html saved:    ${htmlPath} (${html.length} bytes)`);
        console.log(`log saved:    ${logPath}`);
        console.log(`json saved:    ${jsonPath}`);
    } catch (err) {
        console.error("[creepjs] error:", err.message);
        process.exitCode = 1;
    } finally {
        try { ws && ws.close(); } catch (_) {}
        await cleanup();
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
