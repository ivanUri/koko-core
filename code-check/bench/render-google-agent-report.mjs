#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { repoRoot } from "./lib/crawl-wikipedia.mjs";
import { miB } from "./lib/process-monitor.mjs";

const docsDir = resolve(repoRoot, "docs/benchmarks");
const defaultInput = resolve(repoRoot, "code-check/tmp/benchmarks/google-agent.json");

function parseArgs(argv) {
    const out = { input: defaultInput };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--input") out.input = resolve(argv[++i]);
    }
    return out;
}

function fmt(n, d = 1) {
    return n == null || Number.isNaN(n) ? "n/a" : Number(n).toFixed(d);
}

function render(report) {
    const meta = report.meta || {};
    const v = report.velora;
    const c = report.chromium;
    const cmp = report.comparison;
    const date = (meta.timestamp || "").slice(0, 10) || "unknown";

    const lines = [];
    lines.push("# Google agent search benchmark");
    lines.push("");
    lines.push(`> **${meta.timestamp || "unknown"}** · ${meta.limit} queries · concurrency ${meta.concurrency} · extract top ${meta.resultLimit} · ${meta.cpu || "unknown CPU"}`);
    lines.push("");
    lines.push("## What this measures");
    lines.push("");
    lines.push("- **Benchmark class:** `agent-search` — live Google Search → parse SERP → extract organic results");
    lines.push("- **Workload:** agent turns `query → top N results` (title + URL)");
    lines.push(`- **Velora profile:** \`${meta.veloraProfile}\` (baked session cookies via profile seed)`);
    lines.push("- **Chromium:** Playwright headless, **no** Google session jar (cold guest baseline)");
    lines.push(`- **Inter-search gap:** ${meta.interItemDelayMs ?? 0} ms (rate-limit hygiene)`);
    lines.push("");
    lines.push("## Agent path quality");
    lines.push("");
    if (v?.pathHints) {
        lines.push("| Engine | Success | Short SERP | Long bootstrap | Blocked | Mean results | Mean TTFX |");
        lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
        lines.push(`| Velora | ${v.success}/${v.pages} | ${v.pathHints.shortSerp} | ${v.pathHints.longBootstrap} | ${v.pathHints.blocked} | ${fmt(v.pathHints.meanResults, 1)} | ${fmt(v.meanTtfexMs)} ms |`);
        if (c?.pathHints) {
            lines.push(`| Chromium | ${c.success}/${c.pages} | ${c.pathHints.shortSerp} | ${c.pathHints.longBootstrap} | ${c.pathHints.blocked} | ${fmt(c.pathHints.meanResults, 1)} | ${fmt(c.meanTtfexMs)} ms |`);
        }
    }
    lines.push("");
    lines.push("## Throughput & cost");
    lines.push("");
    if (v) {
        lines.push("| Metric | Velora |" + (c ? " Chromium | Ratio (V/C) |" : ""));
        lines.push("| --- | ---:" + (c ? " ---: | ---: |" : ""));
        const rows = [
            ["Wall time", `${v.wallMs} ms`, c?.wallMs, cmp?.wallRatioVeloraOverChromium],
            ["Throughput", `${fmt(v.throughputPagesPerSec, 2)} /s`, c ? fmt(c.throughputPagesPerSec, 2) : null, cmp?.throughputRatioVeloraOverChromium],
            ["Mean latency", `${fmt(v.meanMs)} ms`, c ? fmt(c.meanMs) : null, cmp?.meanLatencyRatio],
            ["Peak RSS", miB(v.resources?.summary?.peakRssBytes), c ? miB(c.resources?.summary?.peakRssBytes) : null, cmp?.peakRssRatio],
            ["CPU-sec/search", v.resources?.summary?.cpuSecondsPerPage, c?.resources?.summary?.cpuSecondsPerPage, cmp?.cpuSecondsPerPageRatio],
        ];
        for (const [label, vv, cc, rr] of rows) {
            lines.push(`| ${label} | ${vv}${c ? ` | ${cc ?? "n/a"} | ${rr != null ? `${fmt(rr, 2)}x` : "n/a"} |` : " |"}`);
        }
    }
    lines.push("");
    if (v?.results?.length) {
        lines.push("## Sample extractions (Velora)");
        lines.push("");
        for (const r of v.results.filter((x) => x.ok).slice(0, 5)) {
            const top = r.results?.[0];
            lines.push(`- **${r.title}** (${r.ms} ms, ${r.pathHint?.shortSerp ? "short-serp" : "other"})`);
            if (top) lines.push(`  - #1: [${top.title}](${top.url})`);
        }
        lines.push("");
    }
    lines.push("## Reproduce");
    lines.push("");
    lines.push("```bash");
    lines.push("zig build -Doptimize=ReleaseFast");
    lines.push("npm run bench:google:agent:publish");
    lines.push("```");
    lines.push("");
    lines.push("Raw JSON: `code-check/tmp/benchmarks/google-agent.json`");
    return { md: lines.join("\n"), date };
}

function main() {
    const { input } = parseArgs(process.argv.slice(2));
    if (!existsSync(input)) {
        console.error(`missing: ${input}`);
        process.exit(1);
    }
    const report = JSON.parse(readFileSync(input, "utf8"));
    const { md, date } = render(report);
    if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });
    const latest = resolve(docsDir, "google-agent-latest.md");
    const dated = resolve(docsDir, `google-agent-${date}.md`);
    writeFileSync(latest, `${md}\n`);
    writeFileSync(dated, `${md}\n`);
    console.log(`saved: ${latest}`);
    console.log(`saved: ${dated}`);
}

main();