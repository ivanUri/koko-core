#!/usr/bin/env node
// Render benchmark JSON to docs/benchmarks/*.md

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { fmt, readJsonFile, repoRoot } from "./lib/compare-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const docsDir = resolve(repoRoot, "docs/benchmarks");
const defaultInput = resolve(repoRoot, "code-check/tmp/benchmarks/run.json");

function parseArgs(argv) {
    const out = { input: defaultInput, help: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
            i += 1;
            return argv[i];
        };
        switch (arg) {
            case "--input": out.input = resolve(next()); break;
            case "--help":
            case "-h": out.help = true; break;
            default:
                if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
        }
    }
    return out;
}

function pctFromRatio(ratio) {
    if (ratio == null || !Number.isFinite(ratio)) return "n/a";
    const delta = (ratio - 1) * 100;
    const sign = delta >= 0 ? "+" : "";
    return `${sign}${delta.toFixed(1)}% vs Chromium`;
}

function tableRow(cells) {
    return `| ${cells.join(" | ")} |`;
}

function renderMarkdown(report) {
    const meta = report.meta || {};
    const startup = report.startup || {};
    const nav = report.navigation?.rows || [];
    const js = report.jsWorkload?.rows || [];
    const summary = report.summary || {};

    const lines = [];

    lines.push("# Velora vs Chromium Benchmark");
    lines.push("");
    lines.push(`> Generated from machine-readable results. Last run: **${meta.timestamp || meta.date || "unknown"}**`);
    lines.push("");
    lines.push("## Executive summary");
    lines.push("");
    lines.push(`- **Host:** ${meta.hostname || "unknown"} (${meta.platform || "?"} ${meta.arch || ""}, ${meta.osRelease || ""})`);
    lines.push(`- **CPU:** ${meta.cpu || "unknown"}`);
    lines.push(`- **Node:** ${meta.node || "?"} · **Playwright Chromium:** ${meta.playwright || "?"} (headless)`);
    lines.push(`- **Velora profile:** \`${meta.veloraProfile || "default"}\`${meta.gitSha ? ` · git \`${meta.gitSha}\`` : ""}`);
    lines.push(`- **Startup ratio (Velora/Chromium):** ${summary.startupRatio == null ? "n/a" : `**${summary.startupRatio.toFixed(2)}x**`} (${pctFromRatio(summary.startupRatio)})`);
    lines.push(`- **Navigation geomean ratio:** ${summary.navigationGeomeanRatio == null ? "n/a" : `**${summary.navigationGeomeanRatio.toFixed(2)}x**`} (${pctFromRatio(summary.navigationGeomeanRatio)})`);
    lines.push(`- **JS workload geomean ratio:** ${summary.jsGeomeanRatio == null ? "n/a" : `**${summary.jsGeomeanRatio.toFixed(2)}x**`} (${pctFromRatio(summary.jsGeomeanRatio)})`);
    lines.push("");
    lines.push("Ratio **> 1.0** means Velora is slower; **< 1.0** means Velora is faster.");
    lines.push("");

    lines.push("## Cold start");
    lines.push("");
    lines.push(tableRow(["Browser", "Mean (ms)", "Median (ms)", "Min (ms)", "Max (ms)", "Errors"]));
    lines.push(tableRow(["---", "---:", "---:", "---:", "---:", "---:"]));
    lines.push(tableRow([
        "Velora",
        fmt(startup.velora?.meanMs),
        fmt(startup.velora?.medianMs),
        fmt(startup.velora?.minMs),
        fmt(startup.velora?.maxMs),
        String(startup.velora?.errors ?? 0),
    ]));
    lines.push(tableRow([
        "Chromium",
        fmt(startup.chromium?.meanMs),
        fmt(startup.chromium?.medianMs),
        fmt(startup.chromium?.minMs),
        fmt(startup.chromium?.maxMs),
        String(startup.chromium?.errors ?? 0),
    ]));
    lines.push(tableRow([
        "**Ratio (Velora/Chromium)**",
        startup.ratio == null ? "n/a" : `**${startup.ratio.toFixed(2)}x**`,
        "",
        "",
        "",
        "",
    ]));
    lines.push("");

    lines.push("## Static page navigation");
    lines.push("");
    lines.push(`Warmup: ${meta.warmup ?? "?"} · Measured repeats: ${meta.repeats ?? "?"}`);
    lines.push("");
    lines.push(tableRow(["Page", "Velora mean", "Chromium mean", "Ratio", "Velora err", "Chromium err"]));
    lines.push(tableRow(["---", "---:", "---:", "---:", "---:", "---:"]));
    for (const row of nav) {
        lines.push(tableRow([
            `\`${row.file}\``,
            `${fmt(row.veloraMeanMs)} ms`,
            `${fmt(row.chromiumMeanMs)} ms`,
            row.ratio == null ? "n/a" : `${row.ratio.toFixed(2)}x`,
            String(row.veloraErrors ?? 0),
            String(row.chromiumErrors ?? 0),
        ]));
    }
    lines.push("");
    lines.push(`**Geomean ratio:** ${summary.navigationGeomeanRatio == null ? "n/a" : `${summary.navigationGeomeanRatio.toFixed(2)}x`}`);
    lines.push("");

    lines.push("## In-page JS workloads");
    lines.push("");
    lines.push(tableRow(["Workload", "Page", "Velora mean", "Chromium mean", "Ratio"]));
    lines.push(tableRow(["---", "---", "---:", "---:", "---:"]));
    for (const row of js) {
        lines.push(tableRow([
            row.name,
            `\`${row.page}\``,
            `${fmt(row.veloraMeanMs)} ms`,
            `${fmt(row.chromiumMeanMs)} ms`,
            row.ratio == null ? "n/a" : `${row.ratio.toFixed(2)}x`,
        ]));
    }
    lines.push("");
    lines.push(`**Geomean ratio:** ${summary.jsGeomeanRatio == null ? "n/a" : `${summary.jsGeomeanRatio.toFixed(2)}x`}`);
    lines.push("");

    lines.push("## Methodology");
    lines.push("");
    lines.push("- **Velora:** `zig-out/bin/velora serve` + CDP navigation/evaluate");
    lines.push("- **Chromium:** Playwright bundled Chromium (`chromium.launch({ headless: true })`) — not Google Chrome desktop");
    lines.push("- **Fixtures:** local static HTML in `velora-test/` (no CDN)");
    lines.push("- **Navigation metric:** `Page.navigate` / `goto` until `domcontentloaded` + DOM size probe");
    lines.push("- **JS metric:** in-page `performance.now()` for dom-query, JSON loop, FNV-style hash loop");
    lines.push(`- **Startup metric:** process spawn until browser ready (Velora: \`/json/version\`; Chromium: launch + \`about:blank\`)`);
    lines.push(`- **Startup warmup/repeats:** ${meta.startupWarmup ?? "?"}/${meta.startupRepeats ?? "?"}`);
    lines.push("");

    lines.push("## Limitations");
    lines.push("");
    lines.push("- Results are from a single machine run; CPU load affects numbers.");
    lines.push("- Local static pages only — not representative of heavy SPAs or real sites.");
    lines.push("- Playwright Chromium differs from installed Google Chrome.");
    lines.push("");

    lines.push("## Reproduce");
    lines.push("");
    lines.push("```bash");
    lines.push("npm run bench:preflight");
    lines.push("npm run bench:compare:publish");
    lines.push("```");
    lines.push("");
    lines.push(`Raw JSON: \`code-check/tmp/benchmarks/run.json\``);
    lines.push("");

    return `${lines.join("\n")}\n`;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log("Usage: npm run bench:compare:report -- [--input <run.json>]");
        return;
    }
    if (!existsSync(opts.input)) {
        throw new Error(`Report not found: ${opts.input}. Run: npm run bench:compare`);
    }

    const report = readJsonFile(opts.input);
    const markdown = renderMarkdown(report);

    if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });

    const latestPath = resolve(docsDir, "latest.md");
    const datedPath = resolve(docsDir, `${report.meta?.date || new Date().toISOString().slice(0, 10)}.md`);

    writeFileSync(latestPath, markdown);
    writeFileSync(datedPath, markdown);

    console.log(`saved: ${latestPath}`);
    console.log(`saved: ${datedPath}`);
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
});