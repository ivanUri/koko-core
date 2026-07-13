#!/usr/bin/env node
/**
 * Probe popular sites via raw CDP to check Velora navigation stability.
 * Each site gets a fresh Velora instance for isolation.
 *
 * Usage:
 *   node code-check/site-stability/run.mjs
 *   node code-check/site-stability/run.mjs --repeats 2 --max-sec 20
 *   node code-check/site-stability/run.mjs --site github,hn
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    connectCDP,
    createVeloraPage,
    delay,
    getFreePort,
    nowMs,
    spawnVelora,
    stopProcess,
    waitForServer,
    writeJsonFile,
} from "../bench/lib/compare-core.mjs";
import {
    deadlineFromMaxSec,
    evaluateWithTimeout,
    killProcess,
    remainingMs,
} from "../../scripts/lib/cdp-probe-budget.mjs";

async function softWithDeadline(deadline, promiseFactory) {
    const ms = remainingMs(deadline);
    if (ms <= 0) return { hung: true };
    const result = await Promise.race([
        promiseFactory(ms),
        delay(ms).then(() => ({ hung: true })),
    ]);
    return result?.hung ? { hung: true } : result;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITES_FILE = resolve(__dirname, "sites.json");
const RESULTS_DIR = resolve(__dirname, "results");

const EXTRACT_EXPR = `(() => ({
  title: document.title || "",
  readyState: document.readyState,
  htmlBytes: document.documentElement?.outerHTML?.length ?? 0,
  bodyBytes: document.body?.innerHTML?.length ?? 0,
  linkCount: document.querySelectorAll("a[href]").length,
  hasBody: !!document.body,
  url: location.href,
}))()`;

const defaults = {
    host: "127.0.0.1",
    maxSec: 20,
    repeats: 2,
    settleMs: 2000,
    profile: "chrome-macos-catalina",
    logLevel: "warn",
    logFormat: "pretty",
    httpTimeoutMs: 30000,
    serverTimeoutMs: 8000,
    report: resolve(RESULTS_DIR, "latest.json"),
};

function usage() {
    return `Usage: node code-check/site-stability/run.mjs [options]

Options:
  --repeats <n>       Runs per site (default: ${defaults.repeats})
  --max-sec <n>       Per-run budget in seconds (default: ${defaults.maxSec})
  --profile <name>    Velora browser profile (default: ${defaults.profile})
  --site <ids>        Comma-separated site ids (default: all)
  --report <path>     JSON report path (default: ${defaults.report})
  --help              Show this help
`;
}

function parseArgs(argv) {
    const opts = { ...defaults, siteFilter: null };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--help" || a === "-h") {
            console.log(usage());
            process.exit(0);
        } else if (a === "--repeats") opts.repeats = Number(argv[++i]);
        else if (a === "--max-sec") opts.maxSec = Number(argv[++i]);
        else if (a === "--profile") opts.profile = argv[++i];
        else if (a === "--site") opts.siteFilter = new Set(argv[++i].split(",").map((s) => s.trim()).filter(Boolean));
        else if (a === "--report") opts.report = resolve(argv[++i]);
        else throw new Error(`Unknown arg: ${a}\n${usage()}`);
    }
    return opts;
}

function loadSites(filter) {
    const data = JSON.parse(readFileSync(SITES_FILE, "utf8"));
    let sites = data.sites ?? [];
    if (filter?.size) sites = sites.filter((s) => filter.has(s.id));
    if (!sites.length) throw new Error("No sites to probe");
    return sites;
}

function validateSite(site, extract) {
    const issues = [];
    if (!extract?.hasBody) issues.push("no body");
    if (site.requireTitle !== false && !extract?.title?.trim()) issues.push("empty title");
    if ((extract?.htmlBytes ?? 0) < (site.minHtmlBytes ?? 1)) {
        issues.push(`html too small (${extract?.htmlBytes ?? 0} < ${site.minHtmlBytes})`);
    }
    if (site.expectTitle && extract?.title !== site.expectTitle) {
        issues.push(`title mismatch (got "${extract?.title}")`);
    }
    return issues;
}

function summarizeRuns(runs) {
    const ok = runs.filter((r) => r.ok);
    const hung = runs.some((r) => r.hung);
    const ms = ok.map((r) => r.ms).sort((a, b) => a - b);
    const html = ok.map((r) => r.extract?.htmlBytes ?? 0);
    const stable = !hung && ok.length === runs.length
        && (html.length === 0 || Math.max(...html) - Math.min(...html) < Math.max(...html) * 0.5);
    return {
        attempts: runs.length,
        passed: ok.length,
        failed: runs.length - ok.length,
        hung,
        stable,
        minMs: ms.length ? ms[0] : null,
        medianMs: ms.length ? ms[Math.floor(ms.length / 2)] : null,
        maxMs: ms.length ? ms[ms.length - 1] : null,
        htmlBytesRange: html.length ? [Math.min(...html), Math.max(...html)] : null,
        errors: runs.filter((r) => !r.ok).map((r) => r.hung ? "[HANG]" : (r.error || r.issues?.join(", "))),
    };
}

async function waitReady(cdp, sessionId, deadline) {
    const expr = `document.readyState === "complete" || document.readyState === "interactive"`;
    for (let i = 0; i < 40; i += 1) {
        if (remainingMs(deadline) <= 200) return;
        const result = await evaluateWithTimeout(cdp, sessionId, expr, Math.min(2000, remainingMs(deadline)));
        if (result.value === true) return;
        await delay(150);
    }
}

async function probeOnce(cdp, page, site, opts) {
    const started = nowMs();
    const deadline = deadlineFromMaxSec(opts.maxSec);

    try {
        const nav = await softWithDeadline(deadline, (ms) =>
            cdp.send("Page.navigate", { url: site.url }, page.sessionId, Math.min(ms, opts.maxSec * 1000))
                .then(() => ({ ok: true }))
                .catch((err) => ({ error: err.message })),
        );
        if (nav.hung) {
            return { ok: false, hung: true, ms: nowMs() - started, error: "navigate timed out" };
        }
        if (nav.error) throw new Error(nav.error);

        await waitReady(cdp, page.sessionId, deadline);
        const settleMs = site.settleMs ?? opts.settleMs;
        if (settleMs) await delay(Math.min(settleMs, remainingMs(deadline)));

        // Sites behind bot challenges (AWS WAF / interstitial) may need extra
        // polls after first paint before the real document replaces a shell.
        const minBytes = site.minHtmlBytes ?? 1;
        let extract = null;
        let lastEvalError = null;
        while (remainingMs(deadline) > 500) {
            const evalResult = await softWithDeadline(deadline, (ms) =>
                evaluateWithTimeout(cdp, page.sessionId, EXTRACT_EXPR, Math.min(ms, 5000)),
            );
            if (evalResult.hung || evalResult.timedOut) {
                return { ok: false, hung: true, ms: nowMs() - started, error: "extract timed out" };
            }
            if (evalResult.error) {
                lastEvalError = evalResult.error;
                await delay(Math.min(400, remainingMs(deadline)));
                continue;
            }
            extract = evalResult.value;
            const hasTitle = (extract?.title || "").trim().length > 0;
            const bigEnough = (extract?.htmlBytes ?? 0) >= minBytes;
            if (hasTitle && bigEnough) break;
            // Shell / challenge pages: keep polling until deadline.
            await delay(Math.min(500, remainingMs(deadline)));
        }
        if (!extract) {
            throw new Error(lastEvalError || "extract failed");
        }

        const issues = validateSite(site, extract);
        const ms = nowMs() - started;

        return {
            ok: issues.length === 0,
            ms,
            extract,
            issues: issues.length ? issues : undefined,
            error: issues.length ? issues.join("; ") : undefined,
        };
    } catch (err) {
        const hung = /timed out|hang/i.test(err.message);
        return {
            ok: false,
            hung,
            ms: nowMs() - started,
            error: err.message,
        };
    }
}

async function runSiteSession(site, opts) {
    const port = await getFreePort(opts.host);
    const endpoint = `http://${opts.host}:${port}`;
    const veloraOpts = {
        host: opts.host,
        logLevel: opts.logLevel,
        logFormat: opts.logFormat,
        httpTimeoutMs: opts.httpTimeoutMs,
        browserProfile: opts.profile,
        commandTimeoutMs: opts.maxSec * 1000,
        serverTimeoutMs: opts.serverTimeoutMs,
    };

    const proc = spawnVelora(port, veloraOpts);
    const runs = [];

    try {
        await waitForServer(`${endpoint}/json/version`, veloraOpts.serverTimeoutMs);
        const cdp = await connectCDP(endpoint, veloraOpts);
        const page = await createVeloraPage(cdp);

        for (let r = 0; r < opts.repeats; r += 1) {
            const outcome = await probeOnce(cdp, page, site, opts);
            runs.push({ run: r + 1, ...outcome });
            const status = outcome.hung ? "HANG" : outcome.ok ? "PASS" : "FAIL";
            const detail = outcome.ok
                ? `${outcome.ms.toFixed(0)}ms, ${outcome.extract?.htmlBytes ?? 0} bytes, "${outcome.extract?.title?.slice(0, 40)}"`
                : outcome.error;
            console.log(`  run ${r + 1}: ${status} — ${detail}`);
            if (outcome.hung) break;
        }

        cdp.close();
    } catch (err) {
        runs.push({ run: runs.length + 1, ok: false, error: err.message });
        console.log(`  session error: ${err.message}`);
    } finally {
        killProcess(proc, "SIGKILL");
        await stopProcess(proc, "SIGKILL", 1500);
    }

    return runs;
}

function printSummary(report) {
    const w = (s, n) => String(s).padEnd(n);
    console.log("\n=== Site stability summary ===\n");
    console.log(`${w("Site", 16)} ${w("Pass", 8)} ${w("Stable", 8)} ${w("Median", 10)} Notes`);
    console.log("-".repeat(72));
    for (const row of report.results) {
        const pass = `${row.summary.passed}/${row.summary.attempts}`;
        const stable = row.summary.hung ? "HANG" : row.summary.stable ? "yes" : "no";
        const median = row.summary.medianMs != null ? `${row.summary.medianMs.toFixed(0)}ms` : "n/a";
        const notes = row.summary.errors[0] || (row.summary.stable ? "" : "variance");
        console.log(`${w(row.id, 16)} ${w(pass, 8)} ${w(stable, 8)} ${w(median, 10)} ${notes}`);
    }
    console.log(`\nOverall: ${report.overall.passedSites}/${report.overall.totalSites} sites passed, ${report.overall.stableSites} stable, ${report.overall.hungSites} hung`);
    console.log(`Report: ${report.reportPath}`);
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const sites = loadSites(opts.siteFilter);
    const results = [];

    for (const site of sites) {
        console.log(`\n--- ${site.name} (${site.url}) ---`);
        const runs = await runSiteSession(site, opts);
        const summary = summarizeRuns(runs);
        results.push({ id: site.id, name: site.name, url: site.url, runs, summary });
    }

    const passedSites = results.filter((r) => r.summary.passed === r.summary.attempts).length;
    const stableSites = results.filter((r) => r.summary.stable).length;
    const hungSites = results.filter((r) => r.summary.hung).length;
    const report = {
        meta: {
            timestamp: new Date().toISOString(),
            veloraProfile: opts.profile,
            repeats: opts.repeats,
            maxSec: opts.maxSec,
        },
        overall: {
            totalSites: results.length,
            passedSites,
            stableSites,
            hungSites,
            allPassed: passedSites === results.length,
            allStable: stableSites === results.length,
        },
        results,
        reportPath: opts.report,
    };

    writeJsonFile(opts.report, report);
    printSummary(report);
    process.exit(hungSites > 0 ? 3 : report.overall.allPassed ? 0 : 1);
}

main().catch((err) => {
    console.error("Probe failed:", err.message);
    process.exit(2);
});