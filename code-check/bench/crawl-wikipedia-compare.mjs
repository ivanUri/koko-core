#!/usr/bin/env node
// Real-world crawl benchmark: N random en.wikipedia.org articles.
// Compare Velora (N processes) vs Chromium (N tabs, 1 process).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    buildQueue,
    collectMeta,
    crawlChromium,
    crawlVelora,
    fetchRandomTitles,
    loadOrFetchTitles,
    repoRoot,
    saveTitles,
} from "./lib/crawl-wikipedia.mjs";
import { fmtCpu, miB } from "./lib/process-monitor.mjs";

const outDir = resolve(repoRoot, "code-check/tmp/benchmarks");
const defaultTitles = resolve(outDir, "wikipedia-titles.json");
const defaultReport = resolve(outDir, "crawl-wikipedia.json");

const defaults = {
    limit: 100,
    concurrency: 8,
    lang: "en",
    timeoutMs: 45000,
    mode: "extract",
    browser: "both",
    titlesFile: defaultTitles,
    report: defaultReport,
    logLevel: "warn",
    browserProfile: "chrome-macos-catalina",
    chromePath: null,
    sampleIntervalMs: 100,
    automation: null,
    veloraMultiProcess: true,
    pageWaitFor: "domcontentloaded",
};

function usage() {
    return `Usage: npm run bench:crawl:wikipedia -- [options]

Crawl random Wikipedia articles over the real internet (not a demo site).

Options:
  --limit N             pages to crawl (default: ${defaults.limit})
  --concurrency N       parallel workers/tabs (default: ${defaults.concurrency})
  --lang CODE           wikipedia language (default: ${defaults.lang})
  --mode extract|html   extract title+links or full HTML size (default: ${defaults.mode})
  --browser velora|chromium|both
  --titles-file PATH    shared title list for fair compare (default: ${defaultTitles})
  --report PATH         JSON output (default: ${defaultReport})
  --timeout MS          per-page timeout (default: ${defaults.timeoutMs})
  --profile NAME        velora browser profile
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
            case "--lang": opts.lang = next(); break;
            case "--mode": opts.mode = next(); break;
            case "--browser": opts.browser = next(); break;
            case "--titles-file": opts.titlesFile = resolve(next()); break;
            case "--report": opts.report = resolve(next()); break;
            case "--timeout": opts.timeoutMs = Number(next()); break;
            case "--profile": opts.browserProfile = next(); break;
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
    if (!["extract", "html"].includes(opts.mode)) throw new Error("--mode must be extract or html");
    if (!["velora", "chromium", "both"].includes(opts.browser)) throw new Error("--browser invalid");
    return opts;
}

function fmt(n, digits = 1) {
    return n == null ? "n/a" : Number(n).toFixed(digits);
}

function printResources(r) {
    if (!r?.summary) return;
    const s = r.summary;
    console.log(`resources:   peak RSS ${miB(s.peakRssBytes)} · avg RSS ${miB(s.avgRssBytes)} · per-page ${miB(s.rssPerPageBytes)}`);
    console.log(`             peak CPU ${fmtCpu(s.peakCpuPercent)} · avg CPU ${fmtCpu(s.avgCpuPercent)} · ~${fmt(s.cpuCoreEquivalents, 2)} cores`);
    console.log(`             processes peak ${s.peakProcessCount ?? "n/a"} · GPU procs ${s.peakGpuProcessCount ?? 0} · GPU RSS ${miB(s.peakGpuRssBytes)}`);
}

function printSummary(label, s) {
    console.log(`\n=== ${label} ===`);
    console.log(`model:       ${s.parallelismModel ?? "n/a"} · parallelism ${s.parallelism}`);
    console.log(`success:     ${s.success}/${s.pages}`);
    console.log(`wall time:   ${s.wallMs} ms (${(s.wallMs / 1000).toFixed(1)}s)`);
    console.log(`throughput:  ${fmt(s.throughputPagesPerSec, 2)} pages/sec`);
    console.log(`latency:     mean ${fmt(s.meanMs)} ms · median ${fmt(s.medianMs)} ms`);
    if (s.totalLinks) console.log(`links found: ${s.totalLinks}`);
    if (s.totalHtmlBytes) {
        console.log(`html bytes:  ${(s.totalHtmlBytes / 1024 / 1024).toFixed(2)} MiB (sampled)`);
    }
    if (s.meanTtfexMs != null) {
        console.log(`ttfx:        mean ${fmt(s.meanTtfexMs)} ms · median ${fmt(s.medianTtfexMs)} ms`);
    }
    printResources(s.resources);
    const rs = s.resources?.summary;
    if (rs?.cpuSecondsPerPage != null) {
        console.log(`cost:        ${rs.cpuSecondsPerPage} CPU-sec/page · ${rs.sessionsPerGb ?? "n/a"} sessions/GB`);
    }
    if (s.failed) {
        console.log(`failures:    ${s.failed}`);
        for (const f of s.failures || []) {
            console.log(`  - ${f.title}: ${f.error}`);
        }
    }
}

function ratio(a, b) {
    return a != null && b != null && b !== 0 ? a / b : null;
}

function buildComparison(v, c) {
    const vr = v.resources?.summary;
    const cr = c.resources?.summary;
    return {
        wallRatioVeloraOverChromium: ratio(v.wallMs, c.wallMs),
        throughputRatioVeloraOverChromium: ratio(v.throughputPagesPerSec, c.throughputPagesPerSec),
        meanLatencyRatio: ratio(v.meanMs, c.meanMs),
        peakRssRatio: ratio(vr?.peakRssBytes, cr?.peakRssBytes),
        avgRssRatio: ratio(vr?.avgRssBytes, cr?.avgRssBytes),
        rssPerPageRatio: ratio(vr?.rssPerPageBytes, cr?.rssPerPageBytes),
        peakCpuRatio: ratio(vr?.peakCpuPercent, cr?.peakCpuPercent),
        avgCpuRatio: ratio(vr?.avgCpuPercent, cr?.avgCpuPercent),
        peakProcessRatio: ratio(vr?.peakProcessCount, cr?.peakProcessCount),
        cpuSecondsPerPageRatio: ratio(vr?.cpuSecondsPerPage, cr?.cpuSecondsPerPage),
        sessionsPerGbRatio: ratio(vr?.sessionsPerGb, cr?.sessionsPerGb),
        meanTtfexRatio: ratio(v.meanTtfexMs, c.meanTtfexMs),
        veloraFaster: v.wallMs < c.wallMs,
        veloraLowerMemory: (vr?.peakRssBytes ?? Infinity) < (cr?.peakRssBytes ?? 0),
        veloraHigherDensity: (vr?.sessionsPerGb ?? 0) > (cr?.sessionsPerGb ?? 0),
    };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    let titles = loadOrFetchTitles(opts);
    if (!titles) {
        console.log(`[titles] fetching ${opts.limit} random ${opts.lang}.wikipedia titles…`);
        titles = await fetchRandomTitles(opts.lang, opts.limit);
        saveTitles(opts.titlesFile, opts.lang, titles);
        console.log(`[titles] saved ${titles.length} titles → ${opts.titlesFile}`);
    } else {
        console.log(`[titles] loaded ${titles.length} titles from ${opts.titlesFile}`);
    }

    const queue = buildQueue(opts.lang, titles.slice(0, opts.limit));
    console.log(`[crawl] site=https://${opts.lang}.wikipedia.org pages=${queue.length} concurrency=${opts.concurrency} mode=${opts.mode}`);

    const report = {
        meta: collectMeta(opts),
        titlesFile: opts.titlesFile,
        titles: titles.slice(0, opts.limit),
        velora: null,
        chromium: null,
        comparison: null,
    };

    if (opts.browser === "velora" || opts.browser === "both") {
        console.log("\n[crawl] Velora (multi-process workers)…");
        report.velora = await crawlVelora(queue, opts);
        printSummary("Velora", report.velora);
    }

    if (opts.browser === "chromium" || opts.browser === "both") {
        console.log("\n[crawl] Chromium (multi-tab, single process)…");
        report.chromium = await crawlChromium(queue, opts);
        printSummary("Chromium", report.chromium);
    }

    if (report.velora && report.chromium) {
        report.comparison = buildComparison(report.velora, report.chromium);
        const cmp = report.comparison;
        console.log("\n=== Comparison (Velora / Chromium) ===");
        console.log(`wall time:         ${fmt(cmp.wallRatioVeloraOverChromium, 2)}x ${cmp.veloraFaster ? "(Velora faster)" : "(Chromium faster)"}`);
        console.log(`throughput:        ${fmt(cmp.throughputRatioVeloraOverChromium, 2)}x`);
        console.log(`mean latency:      ${fmt(cmp.meanLatencyRatio, 2)}x`);
        console.log(`peak memory:       ${fmt(cmp.peakRssRatio, 2)}x ${cmp.veloraLowerMemory ? "(Velora lower)" : "(Chromium lower)"}`);
        console.log(`memory/page:       ${fmt(cmp.rssPerPageRatio, 2)}x`);
        console.log(`peak CPU:          ${fmt(cmp.peakCpuRatio, 2)}x`);
        console.log(`avg CPU:           ${fmt(cmp.avgCpuRatio, 2)}x`);
        console.log(`peak processes:    ${fmt(cmp.peakProcessRatio, 2)}x`);
        console.log(`CPU-sec/page:      ${fmt(cmp.cpuSecondsPerPageRatio, 2)}x`);
        console.log(`sessions/GB:       ${fmt(cmp.sessionsPerGbRatio, 2)}x ${cmp.veloraHigherDensity ? "(Velora denser)" : "(Chromium denser)"}`);
        console.log(`TTFX mean:          ${fmt(cmp.meanTtfexRatio, 2)}x`);
        console.log(`note: crawler-runtime benchmark · Velora=${opts.concurrency} processes · Chromium=${opts.concurrency} tabs`);
    }

    writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nsaved: ${opts.report}`);
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
});