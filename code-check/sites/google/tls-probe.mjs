#!/usr/bin/env node
// Compare TLS/JA3/JA4 fingerprints: curl profiles vs Velora vs real Chrome.
//
// Usage:
//   node code-check/sites/google/tls-probe.mjs
//   node code-check/sites/google/tls-probe.mjs --profile chrome-macos-sonoma
//
// Output: code-check/tmp/tls-probe/report.json

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
const curlDir = resolve(repoRoot, "vendor/curl-impersonate");
const PROBE_URL = "https://tls.peet.ws/api/all";
const DEFAULT_OUTPUT = resolve(repoRoot, "code-check/tmp/tls-probe");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = {
        profile: "chrome-macos-sonoma",
        output: DEFAULT_OUTPUT,
        skipChrome: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
            i += 1;
            return argv[i];
        };
        if (a === "--profile") out.profile = next();
        else if (a === "--output") out.output = resolve(next());
        else if (a === "--skip-chrome") out.skipChrome = true;
    }
    return out;
}

function ja3ExtensionSet(ja3) {
    if (!ja3) return null;
    const parts = ja3.split(",");
    if (parts.length < 3) return null;
    return [...new Set(parts[2].split("-").map(Number))].sort((a, b) => a - b).join("-");
}

function extractTls(payload) {
    const tls = payload?.tls ?? {};
    const h2 = payload?.http2 ?? {};
    const ja3 = tls.ja3 ?? null;
    return {
        ja3,
        ja3_extensions: ja3ExtensionSet(ja3),
        ja3_hash: tls.ja3_hash ?? null,
        ja4: tls.ja4 ?? null,
        ja4_r: tls.ja4_r ?? null,
        akamai: h2.akamai_fingerprint ?? null,
        akamai_hash: h2.akamai_fingerprint_hash ?? null,
        user_agent: payload?.user_agent ?? null,
        tls_version: tls.tls_version_negotiated ?? null,
        cipher_suite: tls.ciphersuite ?? null,
    };
}

async function probeCurl(label, binPath) {
    if (!existsSync(binPath)) return { label, error: "binary_not_found", path: binPath };
    try {
        const { stdout } = await execFileAsync(binPath, [PROBE_URL], { maxBuffer: 2 * 1024 * 1024 });
        const json = JSON.parse(stdout);
        return { label, engine: "curl-impersonate", ...extractTls(json) };
    } catch (err) {
        return { label, engine: "curl-impersonate", error: String(err.message ?? err) };
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

async function waitForCdp(url, ms = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try {
            if ((await fetch(url)).ok) return;
        } catch (_) {}
        await delay(100);
    }
    throw new Error(`CDP not ready: ${url}`);
}

async function spawnVelora(profile, port) {
    const args = [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", profile, "--log-level", "warn",
    ];
    const proc = spawn(veloraBin, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    await waitForCdp(`http://127.0.0.1:${port}/json/version`);
    return proc;
}

async function probeVelora(profile) {
    if (!existsSync(veloraBin)) return { label: "velora", error: "zig build required" };
    const port = await getFreePort();
    const proc = await spawnVelora(profile, port);
    const endpoint = `http://127.0.0.1:${port}`;
    try {
        const browser = await Browser.connect(endpoint);
        const page = await browser.newPage();
        await page.goto(PROBE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        const raw = await page.evaluate(`document.body.innerText`);
        const json = JSON.parse(raw);
        await page.close().catch(() => {});
        await browser.close().catch(() => {});
        return {
            label: `velora (${profile})`,
            engine: "velora",
            profile,
            ...extractTls(json),
        };
    } catch (err) {
        return { label: `velora (${profile})`, engine: "velora", error: String(err.message ?? err) };
    } finally {
        proc.kill("SIGTERM");
        await delay(400);
    }
}

async function probeRealChrome() {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (!existsSync(chrome)) return { label: "real-chrome", error: "chrome_not_installed" };

    const profileDir = resolve(repoRoot, "code-check/tmp/tls-probe/chrome-profile");
    await mkdir(profileDir, { recursive: true });

    const port = 9344;
    try {
        await execFileAsync("bash", ["-lc", `lsof -ti :${port} | xargs kill -9 2>/dev/null || true`]);
    } catch (_) {}

    const proc = spawn(chrome, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run", "--disable-sync", "--headless=new",
        PROBE_URL,
    ], { stdio: "ignore" });

    try {
        await waitForCdp(`http://127.0.0.1:${port}/json/version`, 15_000);
        await delay(2000);
        const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const tab = tabs.find((t) => /tls\.peet\.ws/.test(t.url)) ?? tabs[0];
        if (!tab?.webSocketDebuggerUrl) throw new Error("no debug tab");

        const { chromium } = await import("playwright");
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        const page = browser.contexts()[0]?.pages().find((p) => /tls\.peet\.ws/.test(p.url()))
            ?? browser.contexts()[0]?.pages()[0];
        if (!page) throw new Error("no page");
        const raw = await page.evaluate(`document.body.innerText`);
        const json = JSON.parse(raw);
        await browser.close();
        return {
            label: "real-chrome-149",
            engine: "google-chrome",
            ...extractTls(json),
        };
    } catch (err) {
        return { label: "real-chrome-149", engine: "google-chrome", error: String(err.message ?? err) };
    } finally {
        proc.kill("SIGTERM");
        await delay(400);
    }
}

function compareFingerprints(rows) {
    const valid = rows.filter((r) => r.ja3 && !r.error);
    const baseline = valid.find((r) => r.label === "real-chrome-149") ?? valid[0];
    if (!baseline) return { baseline: null, matches: [] };

    return {
        baseline: baseline.label,
        note: "Chrome 146+ permutes TLS extension order per connection — compare ja3_extensions set, not raw ja3 string.",
        matches: valid.map((r) => ({
            label: r.label,
            ja3_match: r.ja3 === baseline.ja3,
            ja3_ext_set_match: r.ja3_extensions === baseline.ja3_extensions,
            ja4_match: r.ja4 === baseline.ja4,
            akamai_match: r.akamai === baseline.akamai,
            ja3_extensions: r.ja3_extensions,
            ja4: r.ja4,
        })),
    };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    await mkdir(opts.output, { recursive: true });

    console.log(`[probe] ${PROBE_URL}\n`);

    const curlTargets = [
        ["curl-default", "/usr/bin/curl"],
        ["curl-chrome131", resolve(curlDir, "curl_chrome131")],
        ["curl-chrome146", resolve(curlDir, "curl_chrome146")],
    ];

    const rows = [];
    for (const [label, path] of curlTargets) {
        process.stdout.write(`[curl] ${label}... `);
        const row = await probeCurl(label, path);
        rows.push(row);
        console.log(row.error ? `ERR ${row.error}` : `ja3=${row.ja3?.slice(0, 40)}...`);
    }

    process.stdout.write(`[velora] ${opts.profile}... `);
    const veloraRow = await probeVelora(opts.profile);
    rows.push(veloraRow);
    console.log(veloraRow.error ? `ERR ${veloraRow.error}` : `ja3=${veloraRow.ja3?.slice(0, 40)}...`);

    if (!opts.skipChrome) {
        process.stdout.write("[chrome] real Chrome 149... ");
        const chromeRow = await probeRealChrome();
        rows.push(chromeRow);
        console.log(chromeRow.error ? `ERR ${chromeRow.error}` : `ja3=${chromeRow.ja3?.slice(0, 40)}...`);
    }

    const comparison = compareFingerprints(rows);
    const report = {
        probeUrl: PROBE_URL,
        at: new Date().toISOString(),
        profile: opts.profile,
        rows,
        comparison,
        note: "Velora should match curl-chrome146 JA3/JA4. Real Chrome 149 is baseline; gap = remaining Google blockers.",
    };

    await writeFile(resolve(opts.output, "report.json"), JSON.stringify(report, null, 2));

    console.log("\n=== TLS comparison ===");
    console.log(`baseline: ${comparison.baseline ?? "(none)"}`);
    console.log(comparison.note ?? "");
    for (const m of comparison.matches) {
        const flags = [
            m.ja3_ext_set_match ? "ext-set✓" : "ext-set✗",
            m.ja4_match ? "ja4✓" : "ja4✗",
            m.akamai_match ? "h2✓" : "h2✗",
        ].join(" ");
        console.log(`  ${m.label}: ${flags}`);
        if (!m.ja3_ext_set_match) console.log(`    ext-set: ${m.ja3_extensions}`);
    }
    console.log(`\nsaved: ${opts.output}/report.json`);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});