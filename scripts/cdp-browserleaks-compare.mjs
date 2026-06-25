#!/usr/bin/env node
/**
 * Compare Velora profile vs real Chrome on browserleaks TLS/QUIC probes.
 * CDP-only — no Velora SDK.
 *
 * Usage:
 *   node scripts/cdp-browserleaks-compare.mjs
 *   node scripts/cdp-browserleaks-compare.mjs --profile chrome-local-huys-macbook-pro
 */

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const TLS_URL = "https://tls.browserleaks.com/json";
const QUIC_URL = "https://quic.browserleaks.com/";
const DEFAULT_PROFILE = "chrome-local-huys-macbook-pro";
const OUT_DIR = resolve(REPO, "code-check/tmp/browserleaks-compare");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = { profile: DEFAULT_PROFILE, output: OUT_DIR, skipChrome: false };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--profile") out.profile = argv[++i];
        else if (argv[i] === "--output") out.output = resolve(argv[++i]);
        else if (argv[i] === "--skip-chrome") out.skipChrome = true;
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

async function waitCdp(endpoint, ms = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try {
            if ((await fetch(`${endpoint}/json/version`)).ok) return;
        } catch {}
        await delay(100);
    }
    throw new Error(`CDP not ready: ${endpoint}`);
}

class CdpClient {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        this.events = [];
        ws.on("message", (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.method) this.events.push(msg);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                else resolve(msg.result);
            }
        });
        ws.on("close", () => {
            for (const { reject } of this.pending.values()) {
                reject(new Error("CDP WebSocket closed (Velora may have crashed)"));
            }
            this.pending.clear();
        });
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

async function connectBrowserCdp(endpoint) {
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.once("open", res);
        ws.once("error", rej);
    });
    const client = new CdpClient(ws);
    await client.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);
    await client.send("Network.enable", {}, sessionId);
    return { client, sessionId, targetId };
}

async function evaluate(client, sessionId, expression) {
    const result = await client.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
    }, sessionId);
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result?.value;
}

async function fetchPageJson(client, sessionId, url, { retries = 1, waitMs = 1500 } = {}) {
    let protocol = null;
    let lastErr = null;
    for (let attempt = 0; attempt < retries; attempt += 1) {
        client.events.length = 0;
        try {
            await client.send("Page.navigate", { url }, sessionId);
            await delay(waitMs);
            protocol = client.events
                .filter((e) => e.method === "Network.responseReceived")
                .map((e) => e.params?.response)
                .find((r) => r?.url?.includes("browserleaks"))?.protocol ?? null;

            const raw = await evaluate(client, sessionId, `document.body?.innerText || ""`);
            const json = JSON.parse(raw.trim());
            return { json, protocol, attempt: attempt + 1 };
        } catch (err) {
            lastErr = err;
            await delay(800);
        }
    }
    throw lastErr ?? new Error(`failed to load ${url}`);
}

function pickTls(json) {
    return {
        user_agent: json.user_agent ?? null,
        ja3_hash: json.ja3_hash ?? null,
        ja3_text: json.ja3_text ?? null,
        ja3n_hash: json.ja3n_hash ?? null,
        ja3n_text: json.ja3n_text ?? null,
        ja4: json.ja4 ?? null,
        ja4_r: json.ja4_r ?? null,
        ja4_o: json.ja4_o ?? null,
        ja4_ro: json.ja4_ro ?? null,
        akamai_hash: json.akamai_hash ?? null,
        akamai_text: json.akamai_text ?? null,
    };
}

function pickQuic(json) {
    return {
        protocol: json.protocol ?? null,
        message: json.message ?? null,
        user_agent: json.user_agent ?? null,
        ja4: json.ja4 ?? null,
        ja4_r: json.ja4_r ?? null,
        h3_hash: json.h3_hash ?? null,
        h3_text: json.h3_text ?? null,
    };
}

async function spawnVelora(profile) {
    const port = await getFreePort();
    const proc = spawn(VELORA_BIN, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", profile, "--log-level", "warn",
    ], { cwd: REPO, stdio: "ignore" });
    const endpoint = `http://127.0.0.1:${port}`;
    await waitCdp(endpoint);
    return { proc, endpoint, port };
}

async function probeVelora(profile) {
    if (!existsSync(VELORA_BIN)) return { label: `velora (${profile})`, error: "zig build required" };
    const { proc, endpoint } = await spawnVelora(profile);
    let conn = null;
    try {
        conn = await connectBrowserCdp(endpoint);
        const tls = await fetchPageJson(conn.client, conn.sessionId, TLS_URL);
        const quic = await fetchPageJson(conn.client, conn.sessionId, QUIC_URL, { retries: 8, waitMs: 2000 });
        return {
            label: `velora (${profile})`,
            engine: "velora",
            profile,
            tls: { ...pickTls(tls.json), protocol: tls.protocol },
            quic: { ...pickQuic(quic.json), protocol: quic.protocol ?? quic.json.protocol, attempts: quic.attempt },
        };
    } catch (err) {
        const crashed = proc.exitCode !== null || err.message.includes("crashed");
        return {
            label: `velora (${profile})`,
            engine: "velora",
            profile,
            error: String(err.message ?? err),
            crashed,
        };
    } finally {
        conn?.client.close();
        if (proc.exitCode === null) proc.kill("SIGTERM");
        await delay(300);
    }
}

async function probeCurlTransport() {
    const curl146 = resolve(REPO, "vendor/curl-impersonate/curl_chrome146");
    if (!existsSync(curl146)) return { label: "curl-chrome146", error: "binary_not_found" };
    try {
        const { stdout: tlsRaw } = await execFileAsync(curl146, [TLS_URL], { maxBuffer: 4 * 1024 * 1024 });
        const { stdout: quicRaw } = await execFileAsync(
            curl146, ["--http3-only", "-sS", "--max-time", "20", QUIC_URL], { maxBuffer: 4 * 1024 * 1024 },
        );
        const tlsJson = JSON.parse(tlsRaw);
        const quicJson = JSON.parse(quicRaw);
        return {
            label: "curl-chrome146 (velora transport ref)",
            engine: "curl-impersonate",
            note: "Profile transport.impersonate=chrome149; closest bundled binary is curl_chrome146",
            tls: pickTls(tlsJson),
            quic: pickQuic(quicJson),
        };
    } catch (err) {
        return { label: "curl-chrome146", error: String(err.message ?? err) };
    }
}

async function probeRealChrome() {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");

    async function loadJson(url, retries = 1) {
        let protocol = null;
        let body = null;
        const onResponse = (p) => {
            if (p.response?.url?.includes("browserleaks")) protocol = p.response?.protocol ?? null;
        };
        cdp.on("Network.responseReceived", onResponse);
        for (let i = 0; i < retries; i += 1) {
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
            await delay(url.includes("quic") ? 2000 : 1200);
            body = await page.evaluate(() => document.body?.innerText || "");
            try {
                const json = JSON.parse(body.trim());
                if (url.includes("quic") && json.h3_hash) return { json, protocol, attempt: i + 1 };
                if (!url.includes("quic")) return { json, protocol, attempt: i + 1 };
            } catch {}
        }
        cdp.off("Network.responseReceived", onResponse);
        if (!body) throw new Error(`no body for ${url}`);
        return { json: JSON.parse(body.trim()), protocol, attempt: retries };
    }

    try {
        const tls = await loadJson(TLS_URL);
        const quic = await loadJson(QUIC_URL, 8);
        return {
            label: "real-chrome",
            engine: "google-chrome",
            tls: { ...pickTls(tls.json), protocol: tls.protocol },
            quic: { ...pickQuic(quic.json), protocol: quic.protocol ?? quic.json.protocol, attempts: quic.attempt },
        };
    } finally {
        await browser.close();
    }
}

function fieldDiff(key, a, b) {
    const same = JSON.stringify(a) === JSON.stringify(b);
    return { key, match: same, chrome: b, velora: a };
}

function compareTls(velora, chrome) {
    if (!velora?.tls || !chrome?.tls) return [];
    const keys = [
        "ja3_hash", "ja3_text", "ja3n_hash", "ja3n_text",
        "ja4", "ja4_r", "ja4_o", "ja4_ro", "akamai_hash", "akamai_text",
    ];
    return keys.map((k) => fieldDiff(k, velora.tls[k], chrome.tls[k]));
}

function compareQuic(velora, chrome) {
    if (!velora?.quic || !chrome?.quic) return [];
    const keys = ["h3_hash", "h3_text", "ja4", "ja4_r", "protocol"];
    return keys.map((k) => fieldDiff(k, velora.quic[k], chrome.quic[k]));
}

function summarize(diffs) {
    const mismatches = diffs.filter((d) => !d.match);
    return {
        total: diffs.length,
        matches: diffs.length - mismatches.length,
        mismatches: mismatches.map((d) => d.key),
        allMatch: mismatches.length === 0,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    await mkdir(args.output, { recursive: true });

    console.log("=== browserleaks compare (CDP) ===");
    console.log(`profile: ${args.profile}`);
    console.log(`TLS:  ${TLS_URL}`);
    console.log(`QUIC: ${QUIC_URL}\n`);

    console.log("[velora] probing...");
    const velora = await probeVelora(args.profile);
    if (velora.error) {
        console.log(`  ERR ${velora.error}${velora.crashed ? " (segfault)" : ""}`);
    } else {
        console.log(`  tls ja4=${velora.tls.ja4}`);
        console.log(`  quic proto=${velora.quic.protocol} h3=${velora.quic.h3_hash ?? "(none)"} attempts=${velora.quic.attempts}`);
    }

    console.log("[curl] transport reference...");
    const curl = await probeCurlTransport();
    if (curl.error) console.log(`  ERR ${curl.error}`);
    else {
        console.log(`  tls ja4=${curl.tls.ja4}`);
        console.log(`  quic h3=${curl.quic.h3_hash ?? "(none)"}`);
    }

    let chrome = null;
    if (!args.skipChrome) {
        console.log("[chrome] probing...");
        chrome = await probeRealChrome();
        console.log(`  tls ja4=${chrome.tls.ja4}`);
        console.log(`  quic proto=${chrome.quic.protocol} h3=${chrome.quic.h3_hash ?? "(none)"} attempts=${chrome.quic.attempts}`);
    }

    const tlsDiffs = chrome && velora.tls ? compareTls(velora, chrome) : [];
    const quicDiffs = chrome && velora.quic ? compareQuic(velora, chrome) : [];
    const curlTlsDiffs = chrome && curl.tls ? compareTls(curl, chrome) : [];
    const curlQuicDiffs = chrome && curl.quic ? compareQuic(curl, chrome) : [];
    const tlsSummary = summarize(tlsDiffs);
    const quicSummary = summarize(quicDiffs);

    const report = {
        at: new Date().toISOString(),
        profile: args.profile,
        urls: { tls: TLS_URL, quic: QUIC_URL },
        velora,
        curl,
        chrome,
        comparison: {
            velora_vs_chrome: {
                tls: { summary: tlsSummary, diffs: tlsDiffs },
                quic: { summary: quicSummary, diffs: quicDiffs },
            },
            curl_vs_chrome: {
                tls: { summary: summarize(curlTlsDiffs), diffs: curlTlsDiffs },
                quic: { summary: summarize(curlQuicDiffs), diffs: curlQuicDiffs },
            },
        },
        conclusion: velora.error
            ? "velora_crashed_on_https_navigation"
            : !chrome
                ? "chrome_skipped"
                : tlsSummary.allMatch && quicSummary.allMatch
                    ? "velora_matches_chrome"
                    : !quicSummary.allMatch && tlsSummary.allMatch
                        ? "quic_gap_only"
                        : !tlsSummary.allMatch && quicSummary.allMatch
                            ? "tls_gap_only"
                            : "tls_and_quic_gaps",
    };

    const outPath = resolve(args.output, "report.json");
    await writeFile(outPath, JSON.stringify(report, null, 2));

    if (chrome && curl.tls) {
        const ct = summarize(curlTlsDiffs);
        const cq = summarize(curlQuicDiffs);
        console.log("\n--- curl-chrome146 vs real Chrome ---");
        console.log(`TLS: ${ct.matches}/${ct.total}  QUIC: ${cq.matches}/${cq.total}`);
        for (const d of [...curlTlsDiffs, ...curlQuicDiffs].filter((x) => !x.match)) {
            console.log(`FAIL ${d.key}`);
            console.log(`  chrome: ${JSON.stringify(d.chrome)}`);
            console.log(`  curl:   ${JSON.stringify(d.velora)}`);
        }
    }

    if (chrome && velora.tls) {
        console.log("\n--- Velora vs Chrome ---");
        for (const d of [...tlsDiffs, ...quicDiffs].filter((x) => !x.match)) {
            console.log(`FAIL ${d.key}`);
            console.log(`  chrome: ${JSON.stringify(d.chrome)}`);
            console.log(`  velora: ${JSON.stringify(d.velora)}`);
        }
    }

    console.log(`\nconclusion: ${report.conclusion}`);
    console.log(`saved: ${outPath}`);

    if (velora.error) process.exitCode = 2;
    else if (chrome && (!tlsSummary.allMatch || !quicSummary.allMatch)) process.exitCode = 1;
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});