#!/usr/bin/env node
// Agent density sweep: Velora vs Chromium at increasing concurrency.
// Measures how many parallel URL sessions fit on the same machine.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    buildQueue,
    collectMeta,
    crawlChromium,
    crawlVelora,
    loadOrFetchTitles,
    repoRoot,
} from "./lib/crawl-wikipedia.mjs";

const outDir = resolve(repoRoot, "code-check/tmp/benchmarks");
const defaultTitles = resolve(outDir, "wikipedia-titles.json");
const defaultReport = resolve(outDir, "density-sweep.json");

const CONCURRENCY_LEVELS = [1, 4, 8, 16, 32];

const defaults = {
    lang: "en",
    pagesPerLevel: 24,
    timeoutMs: 45000,
    logLevel: "warn",
    browserProfile: "chrome-macos-catalina",
    titlesFile: defaultTitles,
    report: defaultReport,
    levels: CONCURRENCY_LEVELS,
    sampleIntervalMs: 100,
};

function usage() {
    return `Usage: npm run bench:density:sweep -- [options]

Sweep concurrency levels and compare Velora vs Chromium agent density.

Options:
  --pages N             pages per level (default: ${defaults.pagesPerLevel})
  --levels 1,4,8,...    comma-separated concurrency levels
  --report PATH         JSON output (default: ${defaultReport})
  --titles-file PATH    shared Wikipedia title list
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
            case "--pages": opts.pagesPerLevel = Number(next()); break;
            case "--levels": opts.levels = next().split(",").map(Number); break;
            case "--report": opts.report = resolve(next()); break;
            case "--titles-file": opts.titlesFile = resolve(next()); break;
            case "--timeout": opts.timeoutMs = Number(next()); break;
            case "--profile": opts.browserProfile = next(); break;
            case "--help":
            case "-h":
                console.log(usage());
                process.exit(0);
                break;
            default:
                if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
        }
    }
    if (opts.pagesPerLevel < 1) throw new Error("--pages must be >= 1");
    return opts;
}

function res(s) {
    return s?.resources?.summary ?? null;
}

function ratio(a, b) {
    return a != null && b != null && b !== 0 ? a / b : null;
}

function buildComparison(v, c) {
    const vr = res(v);
    const cr = res(c);
    return {
        peakRssRatio: ratio(vr?.peakRssBytes, cr?.peakRssBytes),
        rssPerPageRatio: ratio(vr?.rssPerPageBytes, cr?.rssPerPageBytes),
        sessionsPerGbRatio: ratio(vr?.sessionsPerGb, cr?.sessionsPerGb),
        throughputRatio: ratio(v.throughputPagesPerSec, c.throughputPagesPerSec),
        wallRatio: ratio(v.wallMs, c.wallMs),
        cpuSecondsPerPageRatio: ratio(vr?.cpuSecondsPerPage, cr?.cpuSecondsPerPage),
        veloraSessionsPerGb: vr?.sessionsPerGb ?? null,
        chromiumSessionsPerGb: cr?.sessionsPerGb ?? null,
        veloraPeakRssMiB: vr?.peakRssBytes ? vr.peakRssBytes / (1024 * 1024) : null,
        chromiumPeakRssMiB: cr?.peakRssBytes ? cr.peakRssBytes / (1024 * 1024) : null,
    };
}

function maxConcurrencyAtBudget(levels, engineKey, budgetGb) {
    const budgetBytes = budgetGb * 1024 ** 3;
    let best = 0;
    for (const row of levels) {
        const peak = row[engineKey]?.resources?.summary?.peakRssBytes;
        if (peak && peak <= budgetBytes) best = row.concurrency;
    }
    return best;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
    if (!existsSync(resolve(opts.report, ".."))) mkdirSync(resolve(opts.report, ".."), { recursive: true });

    const titles = loadOrFetchTitles({ titlesFile: opts.titlesFile, limit: opts.pagesPerLevel });
    if (!titles?.length) {
        throw new Error(`Title list missing: ${opts.titlesFile}. Run bench:crawl:wikipedia first.`);
    }

    const baseMeta = collectMeta({
        lang: opts.lang,
        limit: opts.pagesPerLevel,
        concurrency: 0,
        mode: "extract",
        browserProfile: opts.browserProfile,
    });
    baseMeta.benchmarkName = "Agent density sweep";
    baseMeta.benchmarkClass = "agent-density";
    baseMeta.concurrencyLevels = opts.levels;
    baseMeta.pagesPerLevel = opts.pagesPerLevel;

    const report = {
        meta: baseMeta,
        titlesFile: opts.titlesFile,
        levels: [],
        budgets: {},
    };

    console.log(`[density] levels=${opts.levels.join(",")} pages/level=${opts.pagesPerLevel}`);
    console.log(`[density] titles=${titles.length} from ${opts.titlesFile}`);

    for (const concurrency of opts.levels) {
        const limit = Math.min(opts.pagesPerLevel, titles.length);
        const queue = buildQueue(opts.lang, titles.slice(0, limit));
        const crawlOpts = {
            ...opts,
            limit,
            concurrency,
            mode: "extract",
            veloraMultiProcess: true,
            benchmarkClass: "agent-density",
        };

        console.log(`\n=== concurrency ${concurrency} (${limit} pages) ===`);

        console.log("[density] Velora…");
        const velora = await crawlVelora(queue, crawlOpts);
        const vr = res(velora);
        console.log(
            `  velora: peak RSS ${vr?.peakRssBytes ? (vr.peakRssBytes / (1024 * 1024)).toFixed(1) : "n/a"} MiB`
            + ` · ${vr?.sessionsPerGb ?? "n/a"} sessions/GB`
            + ` · ${velora.throughputPagesPerSec?.toFixed(2) ?? "n/a"} p/s`,
        );

        console.log("[density] Chromium…");
        const chromium = await crawlChromium(queue, crawlOpts);
        const cr = res(chromium);
        console.log(
            `  chromium: peak RSS ${cr?.peakRssBytes ? (cr.peakRssBytes / (1024 * 1024)).toFixed(1) : "n/a"} MiB`
            + ` · ${cr?.sessionsPerGb ?? "n/a"} sessions/GB`
            + ` · ${chromium.throughputPagesPerSec?.toFixed(2) ?? "n/a"} p/s`,
        );

        const comparison = buildComparison(velora, chromium);
        console.log(
            `  ratio: sessions/GB ${comparison.sessionsPerGbRatio?.toFixed(2) ?? "n/a"}x`
            + ` · peak RSS ${comparison.peakRssRatio?.toFixed(2) ?? "n/a"}x`,
        );

        report.levels.push({
            concurrency,
            pages: limit,
            velora,
            chromium,
            comparison,
        });
    }

    for (const gb of [1, 2, 4, 8]) {
        report.budgets[`${gb}gb`] = {
            veloraMaxConcurrency: maxConcurrencyAtBudget(report.levels, "velora", gb),
            chromiumMaxConcurrency: maxConcurrencyAtBudget(report.levels, "chromium", gb),
        };
    }

    writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\nsaved: ${opts.report}`);
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
});