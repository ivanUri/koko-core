#!/usr/bin/env node
// Kiểm tra BrowserScan (https://www.browserscan.net/) qua Velora CDP + SDK.
//
// Usage:
//   node code-check/sites/browserscan/scan.mjs
//   node code-check/sites/browserscan/scan.mjs --page home
//   node code-check/sites/browserscan/scan.mjs --page bot
//   node code-check/sites/browserscan/scan.mjs --page all --settle 15

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

const BROWSER_PROFILE = "chrome-macos-catalina";

const PAGES = {
    home: {
        name: "Homepage fingerprint",
        url: "https://www.browserscan.net/",
    },
    bot: {
        name: "Bot detection",
        url: "https://www.browserscan.net/bot-detection",
    },
};

function parseArgs(argv) {
    const out = {
        endpoint: process.env.VELORA_CDP || null,
        page: "all",
        output: resolve(repoRoot, "code-check/tmp/browserscan"),
        timeout: 90_000,
        settleSeconds: 12,
        pollSeconds: 20,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
            i += 1;
            return argv[i];
        };
        switch (a) {
            case "--endpoint": out.endpoint = next(); break;
            case "--page": out.page = next(); break;
            case "--output": out.output = resolve(next()); break;
            case "--timeout": out.timeout = Number(next()); break;
            case "--settle": out.settleSeconds = Number(next()); break;
            case "--poll": out.pollSeconds = Number(next()); break;
            case "--help":
                console.log(
                    "Usage: node scan.mjs [--page home|bot|all] [--endpoint <cdp>] " +
                    "[--settle <s>] [--poll <s>] [--output <dir>]"
                );
                process.exit(0);
                break;
            default:
                if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
        }
    }
    if (!["home", "bot", "all"].includes(out.page)) {
        throw new Error(`Unknown --page value: ${out.page} (use home|bot|all)`);
    }
    return out;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function waitForCdp(url, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try {
            if ((await fetch(url)).ok) return;
        } catch (_) {}
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
        "--browser-profile", BROWSER_PROFILE,
        "--log-level", "warn",
    ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", (c) => stderr.push(c));
    const endpoint = `http://127.0.0.1:${port}`;
    await waitForCdp(`${endpoint}/json/version`);
    return { proc, endpoint, stderr };
}

const HOME_PROBE = `(() => {
    const authEl = document.querySelector('._5tuium');
    const authText = authEl?.innerText?.trim() || '';
    const authMatch = authText.match(/([\\d.]+)%/);
    const authenticity = authMatch ? Number(authMatch[1]) : null;

    const readAnchor = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const valueEl = el.querySelector('._gtrg9a');
        const loading = !!valueEl?.querySelector('.skeleton');
        const value = valueEl?.innerText?.trim()?.slice(0, 120) || null;
        return { value, loading };
    };

    const text = document.body?.innerText || '';
    return {
        title: document.title || '',
        url: location.href,
        authenticity,
        authText,
        webdriver: navigator.webdriver,
        navigator: {
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            languages: navigator.languages,
            plugins: navigator.plugins?.length ?? 0,
        },
        skeletons: document.querySelectorAll('.skeleton').length,
        fields: {
            bot: readAnchor('webdriver_anchor'),
            incognito: readAnchor('incognito'),
            javascript: readAnchor('javascript'),
        },
        pageReady: authenticity !== null && text.length > 1500,
        textLen: text.length,
    };
})()`;

const BOT_PROBE = `(() => {
    const testRoot = document.querySelector('ul._qw0fux');
    const testItems = [...(testRoot?.querySelectorAll('li._90dr3b') || [])].map((li) => ({
        label: (li.querySelector('div')?.innerText || li.innerText || '').trim(),
        warning: !!li.querySelector('._107t7ol'),
    }));

    const guideList = document.querySelector('h1._1p2kna9 + p._7t97is + ul._7t97is, ul._7t97is');
    const guideItems = guideList
        ? [...guideList.querySelectorAll('li')].map((li) => li.innerText.trim())
        : [];

    const cdcKeys = Object.keys(window).filter((k) =>
        /^cdc_|__webdriver|__selenium|__driver|__playwright|__puppeteer/i.test(k)
    );

    const text = document.body?.innerText || '';
    const hasTestResults = text.includes('Test Results') && testItems.length >= 4;
    const noBotsGuide = guideItems.some((t) => /^no bots detected/i.test(t));

    return {
        title: document.title || '',
        url: location.href,
        hasTestResults,
        testItems,
        guideItems,
        noBotsGuide,
        webdriver: navigator.webdriver,
        webdriverProto: 'webdriver' in navigator,
        cdcKeys,
        chromeRuntime: !!(window.chrome && window.chrome.runtime),
        navigator: {
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            languages: navigator.languages,
            plugins: navigator.plugins?.length ?? 0,
        },
        pageReady: hasTestResults && text.length > 800,
        textLen: text.length,
    };
})()`;

function classifyHome(snap) {
    const passed =
        snap.pageReady === true &&
        snap.authenticity !== null &&
        Number.isFinite(snap.authenticity) &&
        snap.webdriver !== true;
    const partial = !passed && snap.authenticity !== null && snap.webdriver !== true;
    return {
        passed,
        partial,
        summary: passed
            ? `fingerprint authenticity ${snap.authenticity}%`
            : partial
                ? `loaded but incomplete (auth=${snap.authenticity}, skeletons=${snap.skeletons})`
                : `homepage probe failed (auth=${snap.authenticity}, webdriver=${snap.webdriver})`,
    };
}

function classifyBot(snap) {
    const labels = new Set((snap.testItems || []).map((t) => t.label.toLowerCase()));
    const expected = ["webdriver", "user-agent", "cdp", "navigator"];
    const hasCategories = expected.every((k) => [...labels].some((l) => l.toLowerCase().includes(k)));
    const warningItems = (snap.testItems || []).filter((t) => t.warning).map((t) => t.label);
    const automationLeak =
        snap.webdriver === true ||
        (snap.cdcKeys?.length ?? 0) > 0;

    const passed =
        snap.pageReady === true &&
        hasCategories &&
        warningItems.length === 0 &&
        !automationLeak;

    const partial = !passed && snap.hasTestResults && !automationLeak;

    return {
        passed,
        partial,
        hasCategories,
        warningItems,
        automationLeak,
        summary: passed
            ? "bot-detection page loaded, no automation leak"
            : automationLeak
                ? `automation leak (webdriver=${snap.webdriver}, cdc=${snap.cdcKeys?.join(",") || "none"})`
                : partial
                    ? `bot page loaded but incomplete (warnings=${warningItems.join(",") || "none"})`
                    : "bot-detection probe failed",
    };
}

async function runPage(page, key, settleSeconds, pollSeconds, t0) {
    const meta = PAGES[key];
    const probeScript = key === "home" ? HOME_PROBE : BOT_PROBE;
    const probes = [];

    console.log(`[goto] ${meta.url}`);
    await page.goto(meta.url, { waitUntil: "load", timeout: 90_000 });
    await delay(settleSeconds * 1000);

    const pollEnd = Date.now() + pollSeconds * 1000;
    while (Date.now() < pollEnd) {
        const atMs = Date.now() - t0;
        const snap = await page.evaluate(probeScript).catch((e) => ({
            pageReady: false,
            error: String(e),
        }));
        probes.push({ atMs, ...snap });

        const readyLabel = key === "home"
            ? `auth=${snap.authenticity ?? "?"} skeletons=${snap.skeletons ?? "?"}`
            : `items=${snap.testItems?.length ?? 0} webdriver=${snap.webdriver}`;
        console.log(`[probe +${atMs}ms] ${key} ready=${snap.pageReady} ${readyLabel}`);

        if (snap.pageReady) break;
        await delay(2500);
    }

    const last = probes.at(-1) || {};
    const verdict = key === "home" ? classifyHome(last) : classifyBot(last);
    const html = await page.content();

    return {
        key,
        name: meta.name,
        url: meta.url,
        probes,
        last,
        verdict,
        html,
    };
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
        console.log(`[velora] ${endpoint} profile=${BROWSER_PROFILE}`);
    }

    const browser = await Browser.connect(endpoint);
    const errors = [];
    const t0 = Date.now();
    const pagesToRun = opts.page === "all" ? ["home", "bot"] : [opts.page];

    try {
        const page = await browser.newPage();
        page.session.on("Runtime.exceptionThrown", (e) => {
            errors.push(e?.exceptionDetails?.text ?? "exception");
        });

        const results = [];
        for (const key of pagesToRun) {
            results.push(await runPage(page, key, opts.settleSeconds, opts.pollSeconds, t0));
        }

        const allPassed = results.every((r) => r.verdict.passed);
        const anyPartial = results.some((r) => r.verdict.partial);
        const report = {
            site: "https://www.browserscan.net/",
            profile: BROWSER_PROFILE,
            pages: results.map((r) => ({
                key: r.key,
                name: r.name,
                url: r.url,
                passed: r.verdict.passed,
                partial: r.verdict.partial,
                summary: r.verdict.summary,
                last: r.last,
                probes: r.probes,
            })),
            errors,
            durationMs: Date.now() - t0,
            passed: allPassed,
            partial: !allPassed && anyPartial,
            summary: allPassed
                ? "BrowserScan checks passed"
                : anyPartial
                    ? "BrowserScan partially passed"
                    : "BrowserScan checks failed",
        };

        for (const r of results) {
            await writeFile(resolve(opts.output, `${r.key}.html`), r.html);
        }
        await writeFile(resolve(opts.output, "report.json"), JSON.stringify(report, null, 2));
        if (stderr.length) {
            await writeFile(resolve(opts.output, "velora.log"), Buffer.concat(stderr).toString());
        }

        console.log("\n=== BrowserScan ===");
        for (const r of results) {
            const { last, verdict } = r;
            console.log(`\n[${r.key}] ${r.name}`);
            console.log(`  url:     ${last.url || r.url}`);
            console.log(`  title:   ${last.title || "(none)"}`);
            if (r.key === "home") {
                console.log(`  auth:    ${last.authenticity ?? "?"}%`);
                console.log(`  webdriver: ${last.webdriver}`);
            } else {
                console.log(`  items:   ${(last.testItems || []).map((t) => t.label).join(", ") || "(none)"}`);
                console.log(`  webdriver: ${last.webdriver}`);
                if (last.noBotsGuide) console.log("  guide:   includes 'No bots detected' copy");
            }
            console.log(`  result:  ${verdict.passed ? "PASS" : verdict.partial ? "PARTIAL" : "FAIL"} — ${verdict.summary}`);
        }

        const exitCode = allPassed ? 0 : anyPartial ? 1 : 2;
        console.log(`\n=== Result: ${allPassed ? "PASS" : anyPartial ? "PARTIAL" : "FAIL"} ===`);
        console.log(`saved: ${opts.output}/report.json`);

        await page.close().catch(() => {});
        process.exitCode = exitCode;
    } finally {
        await browser.close().catch(() => {});
        if (proc) {
            proc.kill("SIGTERM");
            await delay(300);
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});