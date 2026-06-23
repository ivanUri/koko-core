#!/usr/bin/env node
// Google search smoke test via Velora SDK.
// Distinguishes engine health vs Google anti-bot (/sorry).
//
// Usage: npm run test:site:google
//        node code-check/sites/google/search.mjs --query velora

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
function searchUrl(query) {
    return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function parseArgs(argv) {
    const out = {
        endpoint: process.env.VELORA_CDP || null,
        query: "velora",
        output: resolve(repoRoot, "code-check/tmp/google-search"),
        timeout: 60_000,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => { i += 1; return argv[i]; };
        if (a === "--endpoint") out.endpoint = next();
        else if (a === "--query") out.query = next();
        else if (a === "--output") out.output = resolve(next());
        else if (a === "--timeout") out.timeout = Number(next());
        else if (a === "--help") {
            console.log(`Usage: node code-check/sites/google/search.mjs [--query <text>] [--endpoint <url>]

Exit codes:
  0  SERP OK (results found)
  1  Engine OK but Google blocked (/sorry) or no results
  2  Engine broken (could not load Google)
`);
            process.exit(0);
        }
    }
    return out;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function getFreePort() {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.unref();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
    });
}

async function waitForCdp(url, ms = 15_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { if ((await fetch(url)).ok) return; } catch (_) { }
        await delay(100);
    }
    throw new Error(`CDP not ready: ${url}`);
}

async function spawnVelora() {
    if (!existsSync(veloraBin)) throw new Error("Run `zig build` first");
    const port = await getFreePort();
    const stderr = [];
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-catalina",
        "--log-level", "warn",
    ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", (c) => stderr.push(c));
    const endpoint = `http://127.0.0.1:${port}`;
    await waitForCdp(`${endpoint}/json/version`);
    return { proc, endpoint, stderr };
}

async function dismissConsent(page) {
    return page.evaluate(`(() => {
        const buttons = [...document.querySelectorAll('button')];
        const reject = buttons.find(b => /reject all|từ chối|refuse/i.test(b.innerText));
        const accept = buttons.find(b => /accept all|đồng ý|agree|accept/i.test(b.innerText));
        const btn = reject || accept;
        if (btn) { btn.click(); return { clicked: btn.innerText.slice(0, 60) }; }
        return { clicked: null };
    })()`).catch(() => ({ clicked: null }));
}

function classifyResults(results) {
    const blockedSorry = /\/sorry\//.test(results.url) || /unusual traffic/i.test(results.bodySnippet ?? "");
    const serpOk = !blockedSorry && results.resultCount > 0;
    return { blockedSorry, serpOk };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    await mkdir(opts.output, { recursive: true });

    let proc = null;
    let stderr = [];
    let endpoint = opts.endpoint;
    if (!endpoint) {
        const s = await spawnVelora();
        proc = s.proc;
        stderr = s.stderr;
        endpoint = s.endpoint;
        console.log(`[velora] ${endpoint}`);
    }

    const browser = await Browser.connect(endpoint);
    const errors = [];
    const t0 = Date.now();

    try {
        const page = await browser.newPage();
        page.session.on("Runtime.exceptionThrown", (e) => {
            errors.push(e?.exceptionDetails?.text ?? "exception");
        });

        const url = searchUrl(opts.query);
        console.log(`[goto] ${url}`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeout });
        await delay(2000);

        const consent = await dismissConsent(page);
        if (consent.clicked) {
            console.log(`[consent] ${consent.clicked}`);
            await delay(2000);
        }

        const home = await page.evaluate(`(() => ({
            title: document.title,
            url: location.href,
            webdriver: navigator.webdriver,
            ua: navigator.userAgent,
        }))()`);

        console.log("\n=== Page ===");
        console.log(JSON.stringify(home, null, 2));

        const engineOk = /google\.com/.test(home.url);
        if (!engineOk) {
            const report = {
                query: opts.query,
                searchUrl: url,
                home,
                engineOk: false,
                blockedSorry: false,
                serpOk: false,
                errors,
                durationMs: Date.now() - t0,
                note: "Engine broken: could not load Google search page",
            };
            await writeFile(resolve(opts.output, "report.json"), JSON.stringify(report, null, 2));
            console.log("\n=== Verdict: ENGINE_FAIL ===");
            process.exitCode = 2;
            return;
        }

        const results = await page.evaluate(`(() => {
            const items = [...document.querySelectorAll('#search .g h3, #rso .g h3')]
                .slice(0, 8)
                .map((h3) => {
                    const a = h3.closest('a[href]') || h3.parentElement?.querySelector('a[href]');
                    return {
                        title: (h3.innerText || '').slice(0, 120),
                        href: a?.href || '',
                    };
                })
                .filter((x) => x.title || x.href);
            const unique = [];
            const seen = new Set();
            for (const it of items) {
                const k = it.href || it.title;
                if (seen.has(k)) continue;
                seen.add(k);
                unique.push(it);
            }
            return {
                title: document.title,
                url: location.href,
                resultCount: unique.length,
                results: unique.slice(0, 5),
                bodySnippet: (document.body?.innerText || '').slice(0, 600),
            };
        })()`);

        const { blockedSorry, serpOk } = classifyResults(results);

        console.log("\n=== Search results ===");
        console.log(`url:    ${results.url}`);
        console.log(`hits:   ${results.resultCount}`);
        console.log(`blocked_sorry: ${blockedSorry}`);
        for (const [i, r] of results.results.entries()) {
            console.log(`  ${i + 1}. ${r.title}`);
            console.log(`     ${r.href}`);
        }
        if (results.resultCount === 0) {
            console.log("--- body ---");
            console.log(results.bodySnippet);
        }

        const html = await page.content();
        const report = {
            query: opts.query,
            searchUrl: url,
            home,
            consent,
            searchMethod: "direct_url",
            results,
            engineOk: true,
            blockedSorry,
            serpOk,
            errors,
            durationMs: Date.now() - t0,
            note: blockedSorry
                ? "Google anti-bot (/sorry). Engine OK — needs TLS impersonate + IP reputation work."
                : serpOk
                    ? "SERP OK"
                    : "No results but not /sorry — check selectors or query",
        };

        await writeFile(resolve(opts.output, "page.html"), html);
        await writeFile(resolve(opts.output, "report.json"), JSON.stringify(report, null, 2));
        if (stderr.length) await writeFile(resolve(opts.output, "velora.log"), Buffer.concat(stderr).toString());

        if (serpOk) {
            console.log("\n=== Verdict: SERP_OK ===");
            process.exitCode = 0;
        } else if (blockedSorry) {
            console.log("\n=== Verdict: BLOCKED_SORRY (engine OK) ===");
            process.exitCode = 1;
        } else {
            console.log("\n=== Verdict: NO_RESULTS ===");
            process.exitCode = 1;
        }
        console.log(`saved: ${opts.output}/report.json`);

        await page.close().catch(() => { });
    } finally {
        await browser.close().catch(() => { });
        if (proc) {
            proc.kill("SIGTERM");
            await delay(300);
        }
    }
}

main().catch((e) => { console.error(e); process.exit(2); });