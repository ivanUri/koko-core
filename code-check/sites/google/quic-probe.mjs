#!/usr/bin/env node
// Phase 1: QUIC/h3 fingerprint — curl_chrome146 vs Velora vs real Chrome.
// Output: code-check/tmp/quic-probe/report.json
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Browser } from "../../../sdk/dist/index.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const curlBin = resolve(repoRoot, "vendor/curl-impersonate/curl_chrome146");
const PROBE_URL = "https://quic.browserleaks.com/";
const OUT = resolve(repoRoot, "code-check/tmp/quic-probe");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function pickQuic(json) {
    return {
        ja4: json.ja4 ?? null,
        ja4_r: json.ja4_r ?? null,
        h3_hash: json.h3_hash ?? null,
        h3_text: json.h3_text ?? null,
        user_agent: json.user_agent ?? null,
    };
}

async function probeCurlH3() {
    if (!existsSync(curlBin)) return { label: "curl-chrome146-h3", error: "binary_not_found" };
    try {
        const { stdout } = await execFileAsync(curlBin, ["--http3-only", "-sS", "--max-time", "15", PROBE_URL], {
            maxBuffer: 4 * 1024 * 1024,
        });
        return { label: "curl-chrome146-h3", engine: "curl-impersonate", ...pickQuic(JSON.parse(stdout)) };
    } catch (err) {
        return { label: "curl-chrome146-h3", error: String(err.message ?? err) };
    }
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

async function probeVeloraH3() {
    if (!existsSync(veloraBin)) return { label: "velora-h3", error: "zig build required" };
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-sonoma", "--log-level", "warn",
    ], { cwd: repoRoot, stdio: "ignore" });
    const endpoint = `http://127.0.0.1:${port}`;
    try {
        for (let i = 0; i < 40; i++) {
            try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {}
            await delay(100);
        }
        const browser = await Browser.connect(endpoint);
        const page = await browser.newPage();
        const cdp = page.session;
        await cdp.send("Network.enable");
        let proto = null;
        cdp.on("Network.responseReceived", (p) => {
            if (p.response?.url?.includes("browserleaks")) proto = p.response?.protocol ?? null;
        });
        await page.goto(PROBE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const raw = await page.evaluate(() => document.body.innerText);
        const json = JSON.parse(raw);
        await browser.close();
        return { label: "velora-h3", engine: "velora", protocol: proto, ...pickQuic(json) };
    } catch (err) {
        return { label: "velora-h3", error: String(err.message ?? err) };
    } finally {
        proc.kill("SIGTERM");
        await delay(300);
    }
}

async function probeChromeH3() {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    let proto = null;
    let body = null;
    cdp.on("Network.loadingFinished", async (p) => {
        try {
            const b = await cdp.send("Network.getResponseBody", { requestId: p.requestId });
            const t = b.base64Encoded ? Buffer.from(b.body, "base64").toString("utf8") : b.body;
            if (t.includes("h3_hash")) body = t;
        } catch {}
    });
    cdp.on("Network.responseReceived", (p) => {
        if (p.response?.url?.includes("browserleaks")) proto = p.response?.protocol ?? null;
    });
    for (let i = 0; i < 10; i++) {
        await page.goto(PROBE_URL, { waitUntil: "networkidle", timeout: 20_000 }).catch(() => {});
        if (body) break;
    }
    await browser.close();
    if (!body) return { label: "real-chrome-h3", error: "no_h3_response" };
    const json = JSON.parse(body);
    return { label: "real-chrome-h3", engine: "google-chrome", protocol: proto, ...pickQuic(json) };
}

function compare(rows) {
    const baseline = rows.find((r) => r.label === "real-chrome-h3" && r.h3_hash);
    if (!baseline) return { baseline: null, rows: [] };
    return {
        baseline: baseline.label,
        rows: rows.filter((r) => r.h3_hash).map((r) => ({
            label: r.label,
            h3_hash_match: r.h3_hash === baseline.h3_hash,
            h3_text_match: r.h3_text === baseline.h3_text,
            ja4_match: r.ja4 === baseline.ja4,
            h3_hash: r.h3_hash,
            h3_text: r.h3_text,
        })),
    };
}

async function main() {
    await mkdir(OUT, { recursive: true });
    console.log(`[quic-probe] ${PROBE_URL}\n`);

    const rows = [];
    for (const fn of [probeCurlH3, probeVeloraH3, probeChromeH3]) {
        const row = await fn();
        rows.push(row);
        const tag = row.error ? `ERR ${row.error}` : `h3=${row.h3_hash} proto=${row.protocol ?? "?"}`;
        console.log(`[${row.label}] ${tag}`);
        if (row.h3_text) console.log(`  text: ${row.h3_text}`);
    }

    const comparison = compare(rows);
    const report = {
        probeUrl: PROBE_URL,
        at: new Date().toISOString(),
        rows,
        comparison,
        conclusion: rows.find((r) => r.label === "real-chrome-h3")?.h3_hash &&
            rows.find((r) => r.label === "curl-chrome146-h3")?.h3_hash !==
                rows.find((r) => r.label === "real-chrome-h3")?.h3_hash
            ? "curl-impersonate QUIC transport params differ from real Chrome (h3_hash / GREASE). Velora inherits curl stack."
            : "no_quic_gap_detected",
    };

    await writeFile(resolve(OUT, "report.json"), JSON.stringify(report, null, 2));

    console.log("\n=== QUIC comparison ===");
    for (const r of comparison.rows) {
        console.log(
            `  ${r.label}: hash=${r.h3_hash_match ? "✓" : "✗"} text=${r.h3_text_match ? "✓" : "✗"} ja4=${r.ja4_match ? "✓" : "✗"}`,
        );
        if (!r.h3_text_match) console.log(`    chrome: ${comparison.rows.find((x) => x.label === "real-chrome-h3")?.h3_text}`);
        if (!r.h3_text_match) console.log(`    this:   ${r.h3_text}`);
    }
    console.log(`\nconclusion: ${report.conclusion}`);
    console.log(`saved: ${OUT}/report.json`);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});