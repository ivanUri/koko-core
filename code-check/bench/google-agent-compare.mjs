#!/usr/bin/env node
// Google agent benchmark: search → extract top N organic results.
// Velora uses warmed profile cookies; Chromium runs without session jar.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { crawlChromium, crawlVelora, repoRoot } from "./lib/crawl-wikipedia.mjs";
import { miB, fmtCpu } from "./lib/process-monitor.mjs";
import {
    DEFAULT_QUERIES,
    GOOGLE_TTFX_EXPR,
    buildGoogleExtractExpr,
    buildQueryQueue,
    collectGoogleMeta,
    loadOrFetchQueries,
    saveQueries,
    summarizePathHints,
    validateGoogleExtract,
} from "./lib/google-agent.mjs";

const outDir = resolve(repoRoot, "code-check/tmp/benchmarks");
const defaultQueries = resolve(outDir, "google-agent-queries.json");
const defaultReport = resolve(outDir, "google-agent.json");

const defaults = {
    limit: 8,
    concurrency: 1,
    resultLimit: 5,
    timeoutMs: 45000,
    mode: "extract",
    browser: "velora",
    queriesFile: defaultQueries,
    report: defaultReport,
    logLevel: "warn",
    browserProfile: "chrome-macos-catalina",
    chromePath: null,
    sampleIntervalMs: 100,
    interItemDelayMs: 0,
    veloraMultiProcess: true,
    pageWaitFor: "domcontentloaded",
};

function usage() {
    return `Usage: npm run bench:google:agent -- [options]

Google agent benchmark: search query → SERP → extract top organic results.

Options:
  --limit N             number of queries (default: ${defaults.limit})
  --concurrency N       parallel workers (default: ${defaults.concurrency}, use 1 for Google)
  --results N           organic results to extract per query (default: ${defaults.resultLimit})
  --browser velora|chromium|both
  --profile NAME        Velora profile with session cookies (default: ${defaults.browserProfile})
  --gap MS              delay between searches per worker (default: ${defaults.interItemDelayMs})
  --queries-file PATH   shared query list
  --report PATH         JSON output
  --timeout MS          per-search timeout
  --help
`;
}

function parseArgs(argv) {
    const opts = { ...defaults };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
            i += 1;
            return argv[i];
        };
        switch (a) {
            case "--limit": opts.limit = Number(next()); break;
            case "--concurrency": opts.concurrency = Number(next()); break;
            case "--results": opts.resultLimit = Number(next()); break;
            case "--browser": opts.browser = next(); break;
            case "--profile": opts.browserProfile = next(); break;
            case "--gap": opts.interItemDelayMs = Number(next()); break;
            case "--queries-file": opts.queriesFile = resolve(next()); break;
            case "--report": opts.report = resolve(next()); break;
            case "--timeout": opts.timeoutMs = Number(next()); break;
            case "--chrome-path": opts.chromePath = next(); break;
            case "--help":
            case "-h":
                console.log(usage());
                process.exit(0);
                break;
            default:
                if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
        }
    }
    if (!["velora", "chromium", "both"].includes(opts.browser)) throw new Error("--browser invalid");
    return opts;
}

function fmt(n, d = 1) {
    return n == null ? "n/a" : Number(n).toFixed(d);
}

function ratio(a, b) {
    return a != null && b != null && b !== 0 ? a / b : null;
}

function printResources(r) {
    if (!r?.summary) return;
    const s = r.summary;
    console.log(`resources:   peak RSS ${miB(s.peakRssBytes)} · avg RSS ${miB(s.avgRssBytes)}`);
    console.log(`             peak CPU ${fmtCpu(s.peakCpuPercent)} · ~${fmt(s.cpuCoreEquivalents, 2)} cores`);
    if (s.cpuSecondsPerPage != null) {
        console.log(`cost:        ${s.cpuSecondsPerPage} CPU-sec/search`);
    }
}

function printSummary(label, s, pathHints) {
    console.log(`\n=== ${label} ===`);
    console.log(`model:       ${s.parallelismModel ?? "n/a"} · parallelism ${s.parallelism}`);
    console.log(`success:     ${s.success}/${s.pages} (${fmt((s.success / s.pages) * 100, 0)}%)`);
    console.log(`wall time:   ${s.wallMs} ms (${(s.wallMs / 1000).toFixed(1)}s)`);
    console.log(`throughput:  ${fmt(s.throughputPagesPerSec, 2)} searches/sec`);
    console.log(`latency:     mean ${fmt(s.meanMs)} ms · median ${fmt(s.medianMs)} ms`);
    if (s.meanTtfexMs != null) {
        console.log(`ttfx:        mean ${fmt(s.meanTtfexMs)} ms · median ${fmt(s.medianTtfexMs)} ms`);
    }
    if (pathHints) {
        console.log(`paths:       short-serp ${pathHints.shortSerp} · long-bootstrap ${pathHints.longBootstrap} · blocked ${pathHints.blocked}`);
        console.log(`results:     mean ${fmt(pathHints.meanResults, 1)} organic hits/search`);
    }
    printResources(s.resources);
    if (s.failed) {
        console.log(`failures:    ${s.failed}`);
        for (const f of s.failures || []) {
            console.log(`  - "${f.title}": ${f.error}`);
        }
    }
}

function attachPathHints(summary) {
    const pathHints = summarizePathHints(summary.results || []);
    return { ...summary, pathHints };
}

function buildComparison(v, c) {
    const vr = v.resources?.summary;
    const cr = c.resources?.summary;
    return {
        wallRatioVeloraOverChromium: ratio(v.wallMs, c.wallMs),
        throughputRatioVeloraOverChromium: ratio(v.throughputPagesPerSec, c.throughputPagesPerSec),
        meanLatencyRatio: ratio(v.meanMs, c.meanMs),
        meanTtfexRatio: ratio(v.meanTtfexMs, c.meanTtfexMs),
        successRateRatio: ratio(v.success / v.pages, c.success / c.pages),
        peakRssRatio: ratio(vr?.peakRssBytes, cr?.peakRssBytes),
        cpuSecondsPerPageRatio: ratio(vr?.cpuSecondsPerPage, cr?.cpuSecondsPerPage),
        veloraShortSerp: v.pathHints?.shortSerp ?? 0,
        chromiumShortSerp: c.pathHints?.shortSerp ?? 0,
        veloraBlocked: v.pathHints?.blocked ?? 0,
        chromiumBlocked: c.pathHints?.blocked ?? 0,
    };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    let queries = loadOrFetchQueries(opts);
    if (!queries) {
        queries = DEFAULT_QUERIES.slice(0, opts.limit);
        saveQueries(opts.queriesFile, queries);
        console.log(`[queries] seeded ${queries.length} queries → ${opts.queriesFile}`);
    } else {
        console.log(`[queries] loaded ${queries.length} from ${opts.queriesFile}`);
    }
    queries = queries.slice(0, opts.limit);

    const queue = buildQueryQueue(queries);
    const crawlOpts = {
        ...opts,
        benchmarkClass: "agent-search",
        expressions: {
            ttfx: GOOGLE_TTFX_EXPR,
            extract: buildGoogleExtractExpr(opts.resultLimit),
            validate: validateGoogleExtract,
        },
    };

    console.log(`[agent] Google search → extract top ${opts.resultLimit}`);
    console.log(`[agent] queries=${queue.length} concurrency=${opts.concurrency} profile=${opts.browserProfile} gap=${opts.interItemDelayMs}ms`);

    const report = {
        meta: collectGoogleMeta(opts),
        queriesFile: opts.queriesFile,
        queries,
        velora: null,
        chromium: null,
        comparison: null,
    };

    if (opts.browser === "velora" || opts.browser === "both") {
        console.log(`\n[agent] Velora (warmed profile, ${crawlOpts.veloraMultiProcess ? "multi-process" : "single-process"} workers)…`);
        const raw = await crawlVelora(queue, crawlOpts);
        report.velora = attachPathHints(raw);
        printSummary("Velora", report.velora, report.velora.pathHints);
        for (const r of report.velora.results.filter((x) => x.ok).slice(0, 3)) {
            const top = r.results?.[0];
            if (top) console.log(`  ✓ "${r.title}" → ${top.title} (${r.ms}ms)`);
        }
    }

    if (opts.browser === "chromium" || opts.browser === "both") {
        console.log("\n[agent] Chromium (no Google session jar)…");
        const raw = await crawlChromium(queue, crawlOpts);
        report.chromium = attachPathHints(raw);
        printSummary("Chromium", report.chromium, report.chromium.pathHints);
    }

    if (report.velora && report.chromium) {
        report.comparison = buildComparison(report.velora, report.chromium);
        const cmp = report.comparison;
        console.log("\n=== Comparison (Velora / Chromium) ===");
        console.log(`success rate:      Velora ${report.velora.success}/${report.velora.pages} · Chromium ${report.chromium.success}/${report.chromium.pages}`);
        console.log(`short-serp paths:  Velora ${cmp.veloraShortSerp} · Chromium ${cmp.chromiumShortSerp}`);
        console.log(`blocked:           Velora ${cmp.veloraBlocked} · Chromium ${cmp.chromiumBlocked}`);
        console.log(`throughput:        ${fmt(cmp.throughputRatioVeloraOverChromium, 2)}x`);
        console.log(`TTFX mean:         ${fmt(cmp.meanTtfexRatio, 2)}x`);
        console.log(`peak RSS:          ${fmt(cmp.peakRssRatio, 2)}x`);
    }

    writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nsaved: ${opts.report}`);
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
});