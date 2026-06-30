#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { repoRoot } from "./lib/crawl-wikipedia.mjs";
import { miB } from "./lib/process-monitor.mjs";

const docsDir = resolve(repoRoot, "docs/benchmarks");
const defaultInput = resolve(repoRoot, "code-check/tmp/benchmarks/density-sweep.json");

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

function res(s) {
    return s?.resources?.summary ?? null;
}

function render(report) {
    const meta = report.meta || {};
    const date = (meta.timestamp || new Date().toISOString()).slice(0, 10);
    const lines = [];

    lines.push("# Agent density sweep — Velora vs Chromium");
    lines.push("");
    lines.push(`> **${meta.timestamp || "unknown"}** · ${meta.pagesPerLevel} pages/level · levels ${(meta.concurrencyLevels || []).join(", ")} · ${meta.cpu || "unknown CPU"}`);
    lines.push("");
    lines.push("## What this measures");
    lines.push("");
    lines.push("How many **parallel URL sessions** each runtime can sustain on the same machine, at increasing concurrency.");
    lines.push("");
    lines.push("- **Site:** en.wikipedia.org (live crawl, extract mode)");
    lines.push("- **Velora:** N isolated `velora serve` processes (1 tab each)");
    lines.push("- **Chromium:** N tabs in 1 Playwright Chromium browser");
    lines.push("- **Key metric:** `sessions/GB` = how many concurrent workers fit in 1 GiB RAM at peak RSS");
    lines.push("- **Budget table:** max tested concurrency whose peak RSS stays under 1/2/4/8 GB");
    lines.push("");
    lines.push("Ratio **Velora/Chromium > 1** on sessions/GB means Velora fits more parallel URLs per GB.");
    lines.push("");
    lines.push("## Scalability by concurrency");
    lines.push("");
    lines.push("| Concurrency | Velora peak RSS | Chromium peak RSS | Velora sessions/GB | Chromium sessions/GB | Density ratio | Velora p/s | Chromium p/s |");
    lines.push("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");

    for (const row of report.levels || []) {
        const v = row.velora;
        const c = row.chromium;
        const vr = res(v);
        const cr = res(c);
        const cmp = row.comparison || {};
        lines.push(
            `| ${row.concurrency}`
            + ` | ${miB(vr?.peakRssBytes)}`
            + ` | ${miB(cr?.peakRssBytes)}`
            + ` | ${vr?.sessionsPerGb ?? "n/a"}`
            + ` | ${cr?.sessionsPerGb ?? "n/a"}`
            + ` | ${cmp.sessionsPerGbRatio == null ? "—" : `${fmt(cmp.sessionsPerGbRatio, 2)}x`}`
            + ` | ${fmt(v?.throughputPagesPerSec, 2)}`
            + ` | ${fmt(c?.throughputPagesPerSec, 2)} |`,
        );
    }

    lines.push("");
    lines.push("## RAM budget — max concurrency (from measured peak RSS)");
    lines.push("");
    lines.push("| RAM budget | Velora max concurrency | Chromium max concurrency |");
    lines.push("| ---: | ---: | ---: |");
    for (const [key, b] of Object.entries(report.budgets || {})) {
        const label = key.replace("gb", " GB");
        lines.push(`| ${label} | ${b.veloraMaxConcurrency ?? 0} | ${b.chromiumMaxConcurrency ?? 0} |`);
    }

    lines.push("");
    lines.push("## Takeaways");
    lines.push("");

    const last = report.levels?.[report.levels.length - 1];
    const first = report.levels?.[0];
    if (last?.comparison) {
        const c = last.comparison;
        lines.push(`- At **concurrency ${last.concurrency}**: Velora peak ${fmt(c.veloraPeakRssMiB, 0)} MiB vs Chromium ${fmt(c.chromiumPeakRssMiB, 0)} MiB.`);
        lines.push(`- **Sessions/GB** at ${last.concurrency}: Velora **${c.veloraSessionsPerGb ?? "?"}** vs Chromium **${c.chromiumSessionsPerGb ?? "?"}** (${fmt(c.sessionsPerGbRatio, 2)}x).`);
    }
    if (first?.comparison && first.concurrency !== last?.concurrency) {
        const r = first.comparison.sessionsPerGbRatio;
        const ratioText = r == null ? "n/a (Chromium peak RSS > 1 GB at c=1)" : `${fmt(r, 2)}x`;
        lines.push(`- At **concurrency ${first.concurrency}**: density ratio ${ratioText}.`);
    }
    const b1 = report.budgets?.["1gb"];
    if (b1) {
        lines.push(`- Under **1 GB RAM**: Velora supports up to **${b1.veloraMaxConcurrency}** parallel sessions vs Chromium **${b1.chromiumMaxConcurrency}**.`);
    }
    lines.push("- Cold start is not measured here; this sweep focuses on **parallel URL capacity** under fixed hardware.");
    lines.push("");
    lines.push("## Reproduce");
    lines.push("");
    lines.push("```bash");
    lines.push("zig build");
    lines.push("npm run bench:density:publish");
    lines.push("```");
    lines.push("");
    lines.push(`Raw JSON: \`code-check/tmp/benchmarks/density-sweep.json\``);
    lines.push("");

    return { markdown: lines.join("\n"), date };
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!existsSync(opts.input)) {
        throw new Error(`Input not found: ${opts.input}`);
    }
    const report = JSON.parse(readFileSync(opts.input, "utf8"));
    const { markdown, date } = render(report);

    if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });
    const latest = resolve(docsDir, "density-sweep-latest.md");
    const dated = resolve(docsDir, `density-sweep-${date}.md`);
    writeFileSync(latest, markdown);
    writeFileSync(dated, markdown);
    console.log(`saved: ${latest}`);
    console.log(`saved: ${dated}`);
}

main();