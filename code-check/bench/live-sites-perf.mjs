#!/usr/bin/env node
// Detailed live-site performance probe: per-phase latency + process resources.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

import {
    assertReleaseFastBinary,
    veloraBuildMetaForReport,
} from "./lib/compare-core.mjs";
import {
    buildVeloraServeArgs,
    connectCdp,
    fetchPage,
    getFreePort,
    waitFor,
} from "./lib/crawl-wikipedia.mjs";
import { ProcessMonitor, miB, fmtCpu } from "./lib/process-monitor.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const outDir = resolve(repoRoot, "code-check/tmp/benchmarks");
const defaultReport = resolve(outDir, "live-sites-perf.json");

const GENERIC_TTFX = `(() => {
    const el = document.querySelector("h1")
        || document.querySelector("article h2")
        || document.querySelector("[role=main] h2")
        || document.querySelector("main h2");
    return el?.textContent?.trim() || document.title?.trim() || null;
})()`;

const GENERIC_EXTRACT = `(() => ({
    title: document.title?.trim() || "",
    linkCount: document.querySelectorAll("a[href]").length,
    htmlBytes: document.documentElement?.outerHTML?.length ?? 0,
}))()`;

const SITES = [
    { id: "wikipedia-portal", name: "Wikipedia portal", url: "https://www.wikipedia.org", category: "reference" },
    { id: "wikipedia-article", name: "Wikipedia article", url: "https://en.wikipedia.org/wiki/Web_browser", category: "reference" },
    { id: "github", name: "GitHub", url: "https://github.com", category: "tech" },
    { id: "stackoverflow", name: "Stack Overflow", url: "https://stackoverflow.com", category: "tech" },
    { id: "mdn", name: "MDN", url: "https://developer.mozilla.org/en-US/docs/Web/HTML", category: "docs" },
    { id: "hn", name: "Hacker News", url: "https://news.ycombinator.com", category: "news" },
    { id: "bbc", name: "BBC News", url: "https://www.bbc.com/news", category: "news" },
    { id: "reddit", name: "Reddit", url: "https://www.reddit.com", category: "social" },
    { id: "amazon", name: "Amazon", url: "https://www.amazon.com", category: "commerce" },
    { id: "nytimes", name: "NY Times", url: "https://www.nytimes.com", category: "news" },
];

const defaults = {
    repeats: 2,
    warmup: 0,
    timeoutMs: 60000,
    profile: "chrome-macos-catalina",
    logLevel: "warn",
    sampleIntervalMs: 100,
    report: defaultReport,
    sites: null,
};

function usage() {
    return `Usage: node code-check/bench/live-sites-perf.mjs [options]

Detailed Velora live-site probe (domReady · TTFX · extract · RSS/CPU).

Options:
  --repeats N       measured runs per site (default: ${defaults.repeats})
  --warmup N        warmup runs discarded (default: ${defaults.warmup})
  --timeout MS      per-page timeout (default: ${defaults.timeoutMs})
  --profile NAME    browser profile (default: ${defaults.profile})
  --site IDS        comma-separated site ids (default: all)
  --report PATH     JSON output (default: ${defaultReport})
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
            case "--repeats": opts.repeats = Number(next()); break;
            case "--warmup": opts.warmup = Number(next()); break;
            case "--timeout": opts.timeoutMs = Number(next()); break;
            case "--profile": opts.profile = next(); break;
            case "--site": opts.sites = new Set(next().split(",").map((s) => s.trim()).filter(Boolean)); break;
            case "--report": opts.report = resolve(next()); break;
            case "--help":
            case "-h":
                console.log(usage());
                process.exit(0);
                break;
            default:
                if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
        }
    }
    return opts;
}

function fmt(n, d = 0) {
    return n == null ? "n/a" : Number(n).toFixed(d);
}

function summarizeSamples(samples) {
    const ok = samples.filter((s) => s.ok);
    const nums = (key) => ok.map((s) => s[key]).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    const stat = (key) => {
        const v = nums(key);
        if (!v.length) return { mean: null, median: null, min: null, max: null };
        const sum = v.reduce((a, n) => a + n, 0);
        return {
            mean: sum / v.length,
            median: v[Math.floor(v.length / 2)],
            min: v[0],
            max: v[v.length - 1],
        };
    };
    return {
        attempts: samples.length,
        success: ok.length,
        failed: samples.length - ok.length,
        domReadyMs: stat("domReadyMs"),
        ttfexMs: stat("ttfexMs"),
        extractMs: stat("extractMs"),
        totalMs: stat("totalMs"),
        htmlBytes: stat("htmlBytes"),
        linkCount: stat("linkCount"),
        peakRssBytes: stat("peakRssBytes"),
        avgRssBytes: stat("avgRssBytes"),
        peakCpuPercent: stat("peakCpuPercent"),
        errors: samples.filter((s) => !s.ok).map((s) => s.error),
    };
}

async function probeSite(site, opts, client, sessionId, rootPid) {
    const monitor = new ProcessMonitor({ label: site.id, intervalMs: opts.sampleIntervalMs });
    if (rootPid) monitor.addRootPid(rootPid);
    monitor.start();
    const t0 = Date.now();
    try {
        const data = await fetchPage(
            client,
            sessionId,
            site.url,
            opts.timeoutMs,
            "extract",
            { ttfx: GENERIC_TTFX, extract: GENERIC_EXTRACT },
            "domcontentloaded",
        );
        const resources = monitor.stop(1, 1);
        const rs = resources?.summary;
        return {
            ok: true,
            wallMs: Date.now() - t0,
            domReadyMs: data.domReadyMs,
            ttfexMs: data.ttfexMs,
            extractMs: data.extractMs,
            totalMs: data.totalMs,
            htmlBytes: data.htmlBytes,
            linkCount: data.linkCount,
            title: data.title,
            peakRssBytes: rs?.peakRssBytes ?? null,
            avgRssBytes: rs?.avgRssBytes ?? null,
            peakCpuPercent: rs?.peakCpuPercent ?? null,
            processCount: rs?.peakProcessCount ?? null,
        };
    } catch (err) {
        monitor.stop(1, 1);
        return { ok: false, wallMs: Date.now() - t0, error: err.message };
    }
}

async function withVeloraSession(opts, fn) {
    const port = await getFreePort();
    const veloraOpts = {
        logLevel: opts.logLevel,
        browserProfile: opts.profile,
        timeoutMs: opts.timeoutMs,
    };
    const { args } = buildVeloraServeArgs(port, veloraOpts);
    const proc = spawn(resolve(repoRoot, "zig-out/bin/velora"), args, {
        cwd: repoRoot,
        stdio: "ignore",
    });
    try {
        const endpoint = `http://127.0.0.1:${port}`;
        await waitFor(`${endpoint}/json/version`, 15_000);
        const client = await connectCdp(endpoint, 10_000);
        const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
        await client.send("Page.enable", {}, sessionId);
        await client.send("Runtime.enable", {}, sessionId);
        try {
            return await fn({ client, sessionId, proc, endpoint });
        } finally {
            client.close();
        }
    } finally {
        if (proc.exitCode == null) {
            proc.kill("SIGTERM");
            await new Promise((r) => proc.once("exit", r));
        }
    }
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    assertReleaseFastBinary();

    const sites = SITES.filter((s) => !opts.sites || opts.sites.has(s.id));
    if (!sites.length) throw new Error("No sites selected");

    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    const report = {
        meta: {
            timestamp: new Date().toISOString(),
            benchmarkName: "Live sites detailed performance",
            repeats: opts.repeats,
            warmup: opts.warmup,
            timeoutMs: opts.timeoutMs,
            profile: opts.profile,
            isolation: "fresh-velora-per-site",
            measurementPhases: ["domReadyMs", "ttfexMs", "extractMs", "totalMs"],
            ...veloraBuildMetaForReport(),
        },
        sites: [],
    };

    console.log(`[live-perf] ${sites.length} sites · repeats=${opts.repeats} warmup=${opts.warmup} timeout=${opts.timeoutMs}ms · fresh instance/site`);
    console.log("─".repeat(100));

    for (const site of sites) {
        console.log(`\n▶ ${site.name} (${site.id})`);
        console.log(`  ${site.url}`);
        const samples = [];

        for (let w = 0; w < opts.warmup; w += 1) {
            const warm = await withVeloraSession(opts, ({ client, sessionId, proc }) =>
                probeSite(site, opts, client, sessionId, proc.pid),
            );
            console.log(`  warmup ${w + 1}: ${warm.ok ? `${fmt(warm.totalMs)}ms` : warm.error}`);
        }

        for (let r = 0; r < opts.repeats; r += 1) {
            const result = await withVeloraSession(opts, ({ client, sessionId, proc }) =>
                probeSite(site, opts, client, sessionId, proc.pid),
            );
            samples.push(result);
            if (result.ok) {
                console.log(
                    `  run ${r + 1}: total=${fmt(result.totalMs)}ms`
                    + ` dom=${fmt(result.domReadyMs)} ttfx=${fmt(result.ttfexMs)} extract=${fmt(result.extractMs)}`
                    + ` html=${(result.htmlBytes / 1024).toFixed(0)}KiB links=${result.linkCount}`
                    + ` rss=${miB(result.peakRssBytes)} cpu=${fmtCpu(result.peakCpuPercent)}`
                    + ` procs=${result.processCount ?? "n/a"}`
                    + ` "${(result.title || "").slice(0, 50)}"`,
                );
            } else {
                console.log(`  run ${r + 1}: FAIL — ${result.error}`);
            }
        }

        const summary = summarizeSamples(samples);
        report.sites.push({ ...site, samples, summary });
        if (summary.success) {
            console.log(
                `  ► median: total=${fmt(summary.totalMs.median)}ms`
                + ` dom=${fmt(summary.domReadyMs.median)} ttfx=${fmt(summary.ttfexMs.median)} extract=${fmt(summary.extractMs.median)}`
                + ` rss=${miB(summary.peakRssBytes.median)} cpu=${fmtCpu(summary.peakCpuPercent.median)}`,
            );
        }
    }

    const okSites = report.sites.filter((s) => s.summary.success > 0);
    const totals = okSites.map((s) => s.summary.totalMs.median).filter(Number.isFinite).sort((a, b) => a - b);
    report.aggregate = {
        sitesTested: report.sites.length,
        sitesOk: okSites.length,
        medianTotalMs: totals.length ? totals[Math.floor(totals.length / 2)] : null,
        meanTotalMs: totals.length ? totals.reduce((a, n) => a + n, 0) / totals.length : null,
    };

    writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
    console.log("\n" + "═".repeat(100));
    console.log("AGGREGATE");
    console.log(`  sites OK: ${report.aggregate.sitesOk}/${report.aggregate.sitesTested}`);
    console.log(`  median total latency: ${fmt(report.aggregate.medianTotalMs)} ms`);
    console.log(`  mean total latency:   ${fmt(report.aggregate.meanTotalMs)} ms`);
    console.log(`  report: ${opts.report}`);
}

main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
});