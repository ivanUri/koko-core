#!/usr/bin/env node
// Thử search Google qua Velora CDP + SDK.
// Usage: node code-check/sites/google/search.mjs [--query "velora browser"]

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

function parseArgs(argv) {
    const out = {
        endpoint: process.env.VELORA_CDP || null,
        query: "velora browser zig",
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
            console.log("Usage: node google-search-test.mjs [--query <text>] [--endpoint <url>]");
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

async function waitForCdp(url, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try { if ((await fetch(url)).ok) return; } catch (_) {}
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

        // 1) Mở Google homepage
        console.log("[goto] https://www.google.com/");
        await page.goto("https://www.google.com/", { waitUntil: "load", timeout: opts.timeout });
        await delay(2000);

        let home = await page.evaluate(`(() => ({
            title: document.title,
            url: location.href,
            hasSearchBox: !!(document.querySelector('textarea[name="q"], input[name="q"]')),
            hasConsent: !!document.querySelector('button, form[action*="consent"]'),
            bodyStart: (document.body?.innerText || '').slice(0, 300),
        }))()`);

        console.log("\n=== Homepage ===");
        console.log(JSON.stringify(home, null, 2));

        // Dismiss consent nếu có (EU / một số region)
        const consent = await page.evaluate(`(() => {
            const buttons = [...document.querySelectorAll('button')];
            const reject = buttons.find(b => /reject all|từ chối|refuse/i.test(b.innerText));
            const accept = buttons.find(b => /accept all|đồng ý|agree/i.test(b.innerText));
            const btn = reject || accept;
            if (btn) { btn.click(); return { clicked: btn.innerText.slice(0, 40) }; }
            return { clicked: null };
        })()`).catch(() => ({ clicked: null }));

        if (consent.clicked) {
            console.log(`[consent] clicked: ${consent.clicked}`);
            await delay(2000);
            home = await page.evaluate(`(() => ({
                title: document.title,
                url: location.href,
                hasSearchBox: !!(document.querySelector('textarea[name="q"], input[name="q"]')),
            }))()`);
        }

        // 2) Search — dùng Page.navigate (tránh form.submit phá execution context)
        const query = opts.query;
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
        console.log(`\n[search] query="${query}"`);
        console.log(`[goto] ${searchUrl}`);

        const fillProbe = await page.evaluate(`(() => {
            const input = document.querySelector('textarea[name="q"], input[name="q"]');
            if (!input) return { filled: false };
            input.value = ${JSON.stringify(query)};
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return { filled: true, value: input.value };
        })()`).catch((e) => ({ filled: false, error: String(e) }));

        const searchAction = { fillProbe, method: "page_navigate", url: searchUrl };
        await page.goto(searchUrl, { waitUntil: "load", timeout: opts.timeout });
        await delay(2000);

        const results = await page.evaluate(`(() => {
            const items = [...document.querySelectorAll('#search .g, #rso .g, [data-sokoban-container] a h3')]
                .slice(0, 8)
                .map((el) => {
                    const h3 = el.querySelector?.('h3') || (el.tagName === 'H3' ? el : null);
                    const a = el.querySelector?.('a[href]') || el.closest?.('a[href]');
                    return {
                        title: (h3?.innerText || el.innerText || '').slice(0, 120),
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
                isSearchResults: /google\\.[a-z.]+\\/search/.test(location.href) || location.search.includes('q='),
                resultCount: unique.length,
                results: unique.slice(0, 5),
                bodySnippet: (document.body?.innerText || '').slice(0, 500),
            };
        })()`);

        console.log("\n=== Search results ===");
        console.log(`title:  ${results.title}`);
        console.log(`url:    ${results.url}`);
        console.log(`is SERP: ${results.isSearchResults}`);
        console.log(`hits:   ${results.resultCount}`);
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
            query,
            home,
            consent,
            searchAction,
            results,
            errors,
            durationMs: Date.now() - t0,
            passed: results.isSearchResults && results.resultCount > 0,
        };

        await writeFile(resolve(opts.output, "page.html"), html);
        await writeFile(resolve(opts.output, "report.json"), JSON.stringify(report, null, 2));
        if (stderr.length) await writeFile(resolve(opts.output, "velora.log"), Buffer.concat(stderr).toString());

        console.log(`\n=== Verdict: ${report.passed ? "PASS" : "PARTIAL/FAIL"} ===`);
        console.log(`saved: ${opts.output}/report.json`);

        await page.close().catch(() => {});
        process.exitCode = report.passed ? 0 : 1;
    } finally {
        await browser.close().catch(() => {});
        if (proc) {
            proc.kill("SIGTERM");
            await delay(300);
        }
    }
}

main().catch((e) => { console.error(e); process.exit(1); });