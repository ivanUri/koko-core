#!/usr/bin/env node
// Agent-style extract benchmark: top Hacker News item pages (live internet).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { arch, cpus, hostname, platform, release } from "node:os";
import { execSync } from "node:child_process";

import { crawlChromium, crawlVelora, repoRoot } from "./lib/crawl-wikipedia.mjs";
import {
    buildHnQueue,
    fetchTopStoryIds,
    hnCollectMeta,
    hnExpressions,
    loadOrFetchIds,
    saveIds,
} from "./lib/crawl-hn.mjs";
import { fmtCpu, miB } from "./lib/process-monitor.mjs";

const outDir = resolve(repoRoot, "code-check/tmp/benchmarks");
const defaultIds = resolve(outDir, "hn-story-ids.json");
const defaultReport = resolve(outDir, "crawl-hn.json");

const defaults = {
    limit: 100,
    concurrency: 8,
    timeoutMs: 45000,
    mode: "extract",
    browser: "both",
    titlesFile: defaultIds,
    report: defaultReport,
    logLevel: "warn",
    browserProfile: "chrome-macos-catalina",
    chromePath: null,
    sampleIntervalMs: 100,
};

function usage() {
    return `Usage: npm run bench:crawl:hn -- [options]

Crawl top Hacker News item pages (agent extract workload).

Options:
  --limit N             pages (default: ${defaults.limit})
  --concurrency N       parallel workers/tabs (default: ${defaults.concurrency})
  --browser velora|chromium|both
  --ids-file PATH       shared story id list (default: ${defaultIds})
  --report PATH         JSON output (default: ${defaultReport})
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
            case "--browser": opts.browser = next(); break;
            case "--ids-file": opts.titlesFile = resolve(next()); break;
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
    if (!["velora", "chromium", "both"].includes(opts.browser)) throw new Error("--browser invalid");
    return opts;
}

function fmt(n, digits = 1) {
    return n == null ? "n/a" : Number(n).toFixed(digits);
}

function printSummary(label, s) {
    console.log(`\n=== ${label} ===`);
    console.log(`model:       ${s.parallelismModel ?? "n/a"} · parallelism ${s.parallelism}`);
    console.log(`success:     ${s.success}/${s.pages}`);
    console.log(`wall time:   ${s.wallMs} ms (${(s.wallMs / 1000).toFixed(1)}s)`);
    console.log(`throughput:  ${fmt(s.throughputPagesPerSec, 2)} pages/sec`);
    console.log(`latency:     mean ${fmt(s.meanMs)} ms · median ${fmt(s.medianMs)} ms`);
    if (s.meanTtfexMs != null) {
        console.log(`ttfx:        mean ${fmt(s.meanTtfexMs)} ms · median ${fmt(s.medianTtfexMs)} ms`);
    }
    const rs = s.resources?.summary;
    if (rs) {
        console.log(`resources:   peak RSS ${miB(rs.peakRssBytes)} · per-page ${miB(rs.rssPerPageBytes)}`);
        console.log(`cost:        ${rs.cpuSecondsPerPage} CPU-sec/page · ${rs.sessionsPerGb ?? "n/a"} sessions/GB`);
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
        cpuSecondsPerPageRatio: ratio(vr?.cpuSecondsPerPage, cr?.cpuSecondsPerPage),
        sessionsPerGbRatio: ratio(vr?.sessionsPerGb, cr?.sessionsPerGb),
        meanTtfexRatio: ratio(v.meanTtfexMs, c.meanTtfexMs),
        veloraFaster: v.wallMs < c.wallMs,
        veloraLowerMemory: (vr?.peakRssBytes ?? Infinity) < (cr?.peakRssBytes ?? 0),
        veloraHigherDensity: (vr?.sessionsPerGb ?? 0) > (cr?.sessionsPerGb ?? 0),
    };
}

function collectMetaFull(opts) {
    let gitSha = null;
    try {
        gitSha = execSync("git rev-parse --short HEAD", { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] })
            .toString()
            .trim();
    } catch (_) {}
    const cpu = cpus()[0];
    return {
        timestamp: new Date().toISOString(),
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        osRelease: release(),
        cpu: cpu ? `${cpu.model} (${cpus().length} cores)` : null,
        node: process.version,
        gitSha,
        ...hnCollectMeta(opts),
    };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    opts.expressions = hnExpressions();
    opts.benchmarkClass = "agent-extract";
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    let ids = loadOrFetchIds(opts);
    if (!ids) {
        console.log(`[hn] fetching top ${opts.limit} story ids…`);
        ids = await fetchTopStoryIds(opts.limit);
        saveIds(opts.titlesFile, ids);
        console.log(`[hn] saved ${ids.length} ids → ${opts.titlesFile}`);
    } else {
        console.log(`[hn] loaded ${ids.length} ids from ${opts.titlesFile}`);
    }

    const queue = buildHnQueue(ids.slice(0, opts.limit));
    console.log(`[crawl] site=https://news.ycombinator.com pages=${queue.length} concurrency=${opts.concurrency}`);

    const report = {
        meta: collectMetaFull(opts),
        titlesFile: opts.titlesFile,
        storyIds: ids.slice(0, opts.limit),
        velora: null,
        chromium: null,
        comparison: null,
    };

    if (opts.browser === "velora" || opts.browser === "both") {
        console.log("\n[crawl] Velora…");
        report.velora = await crawlVelora(queue, opts);
        printSummary("Velora", report.velora);
    }

    if (opts.browser === "chromium" || opts.browser === "both") {
        console.log("\n[crawl] Chromium…");
        report.chromium = await crawlChromium(queue, opts);
        printSummary("Chromium", report.chromium);
    }

    if (report.velora && report.chromium) {
        report.comparison = buildComparison(report.velora, report.chromium);
        const cmp = report.comparison;
        console.log("\n=== Comparison (Velora / Chromium) ===");
        console.log(`wall time:      ${fmt(cmp.wallRatioVeloraOverChromium, 2)}x`);
        console.log(`peak memory:    ${fmt(cmp.peakRssRatio, 2)}x`);
        console.log(`CPU-sec/page:   ${fmt(cmp.cpuSecondsPerPageRatio, 2)}x`);
        console.log(`sessions/GB:    ${fmt(cmp.sessionsPerGbRatio, 2)}x`);
        console.log(`TTFX mean:      ${fmt(cmp.meanTtfexRatio, 2)}x`);
    }

    writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nsaved: ${opts.report}`);
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
});