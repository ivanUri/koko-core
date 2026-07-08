#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { repoRoot } from "./lib/crawl-wikipedia.mjs";
import { fmtCpu, miB } from "./lib/process-monitor.mjs";

const docsDir = resolve(repoRoot, "docs/benchmarks");
const defaultInput = resolve(repoRoot, "code-check/tmp/benchmarks/crawl-wikipedia.json");

function parseArgs(argv) {
    const out = { input: defaultInput, outputPrefix: "crawl-wikipedia", format: "md" };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--input") out.input = resolve(argv[++i]);
        if (argv[i] === "--output-prefix") out.outputPrefix = argv[++i];
        if (argv[i] === "--format") out.format = argv[++i];
        if (argv[i] === "--html") out.format = "html";
    }
    return out;
}

function esc(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function ratioClass(r, invert = false) {
    if (r == null) return "";
    const good = invert ? r > 1 : r < 1;
    if (Math.abs(r - 1) < 0.05) return "neutral";
    return good ? "good" : "bad";
}

function row(cells, tag = "td") {
    return `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
}

function fmt(n, d = 1) {
    return n == null || Number.isNaN(n) ? "n/a" : Number(n).toFixed(d);
}

function ratioCell(r) {
    return r == null ? "n/a" : `${fmt(r, 2)}x`;
}

function res(s) {
    return s?.resources?.summary ?? null;
}

function render(report, rawJsonPath = defaultInput) {
    const meta = report.meta || {};
    const v = report.velora;
    const c = report.chromium;
    const cmp = report.comparison;
    const vr = res(v);
    const cr = res(c);
    const benchClass = v?.benchmarkClass || c?.benchmarkClass || "crawler-runtime";

    const title = meta.benchmarkName || "Real-world crawl benchmark";
    const itemLabel = report.storyIds ? "story pages" : "article URLs";
    const lane = meta.benchmarkLane ?? (meta.veloraMultiProcess === false ? "fair" : "density");
    const isFair = lane === "fair";

    const lines = [];
    lines.push(`# ${title}`);
    lines.push("");
    lines.push(`> **${meta.timestamp || "unknown"}** · lane **${lane}** · ${meta.limit} pages · concurrency ${meta.concurrency} · ${meta.cpu || "unknown CPU"}`);
    lines.push("");
    lines.push("## What this measures");
    lines.push("");
    lines.push(`- **Benchmark lane:** \`${lane}\` — ${isFair
        ? "fair throughput (1 Velora process, shared HTTP cache, warmup)"
        : "agent density (N isolated Velora processes, cold per worker)"}`);
    lines.push(`- **Benchmark class:** \`${benchClass}\` — network → HTML parse → DOM extract (not full browser fidelity)`);
    lines.push(`- **Site:** ${meta.site} (live internet)`);
    lines.push(`- **Workload:** ${meta.limit} ${itemLabel} (shared list: \`${report.titlesFile}\`)`);
    lines.push(`- **Mode:** \`${meta.mode}\` (title + wiki links via \`querySelector\`)`);
    if (isFair) {
        lines.push(`- **Velora:** 1× \`velora serve\`, ${meta.concurrency} CDP sessions (${v?.parallelismModel || "multi-session-single-process"})`);
        lines.push(`- **HTTP cache:** ${meta.httpCacheEnabled ? `\`${meta.httpCacheDir}\`` : "disabled"}`);
        lines.push(`- **Warmup:** ${meta.warmup ? `\`${meta.warmupUrl}\` (excluded from measured wall time)` : "none"}`);
    } else {
        lines.push(`- **Velora:** ${meta.concurrency}× \`velora serve\` (${v?.parallelismModel || "multi-process"})`);
        lines.push("- **HTTP cache:** disabled (intentional — measures cold worker footprint)");
        lines.push("- **Warmup:** none");
    }
    lines.push(`- **Chromium:** ${meta.concurrency} tabs, 1 browser (${c?.parallelismModel || "multi-tab"})`);
    if (meta.warmup) {
        lines.push(`- **Chromium warmup:** same as Velora (\`${meta.warmupUrl}\`, excluded from wall time)`);
    }
    lines.push(`- **Resource sampling:** every ${vr?.intervalMs ?? 100}ms via process tree (RSS, CPU%, process count)`);
    lines.push("- **GPU:** utilization not available headless; we log GPU helper process count + RSS if spawned");
    lines.push("");

    lines.push("## Architecture (read before comparing process count)");
    lines.push("");
    lines.push("| | Velora | Chromium |");
    lines.push("| --- | --- | --- |");
    if (isFair) {
        lines.push(`| Parallelism unit | 1 \`velora serve\`, ${meta.concurrency} CDP sessions | ${meta.concurrency} tabs in 1 browser |`);
        lines.push("| Shared resources | Network, HttpClient, optional HTTP disk cache | browser network stack + disk cache |");
    } else {
        lines.push(`| Parallelism unit | ${meta.concurrency} isolated \`velora serve\` processes | ${meta.concurrency} tabs in 1 browser |`);
        lines.push("| Shared resources | none across workers (by design) | browser network stack + disk cache |");
    }
    lines.push("| OS process model | 1 process tree per worker (summed) | browser + N renderers + GPU + network + utility + crashpad |");
    lines.push(`| This run (peak procs) | ${vr?.peakProcessCount ?? "n/a"} | ${cr?.peakProcessCount ?? "n/a"} |`);
    if (v?.architectureNote) lines.push(`| Note | ${v.architectureNote} | ${c?.architectureNote || ""} |`);
    lines.push("");
    if (isFair) {
        lines.push("This lane compares **throughput and TTFX** under similar sharing assumptions. Prefer **wall time**, **throughput**, and **TTFX** over raw process count.");
    } else {
        lines.push("This lane compares **agent density**. Prefer **RSS/page**, **sessions/GB**, and **CPU-sec/page**. Peak process count and peak RSS are **not apples-to-apples** vs Chromium.");
    }
    lines.push("");

    lines.push("## Limitations (crawler vs AI browser runtime)");
    lines.push("");
    lines.push("Wikipedia articles are mostly static HTML. This workload does **not** stress:");
    lines.push("");
    lines.push("- WebGL / Canvas / heavy JS frameworks");
    lines.push("- SPA routing or React hydration");
    lines.push("- Service workers, bot detection (reCAPTCHA, Cloudflare)");
    lines.push("- Agent workflows (search → click → extract, login, forms)");
    lines.push("");
    if (v?.workloadNote) lines.push(`> ${v.workloadNote}`);
    lines.push("");

    if (cmp && v && c) {
        lines.push("## Scalability comparison");
        lines.push("");
        lines.push("Ratio **Velora / Chromium**. Values **< 1** mean Velora uses less (better for memory/CPU/time); **> 1** means Velora uses more.");
        lines.push("");
        lines.push("| Metric | Velora | Chromium | Ratio (V/C) |");
        lines.push("| --- | ---: | ---: | ---: |");
        lines.push(`| Wall time | ${fmt(v.wallMs, 0)} ms | ${fmt(c.wallMs, 0)} ms | ${ratioCell(cmp.wallRatioVeloraOverChromium)} |`);
        lines.push(`| Throughput | ${fmt(v.throughputPagesPerSec, 2)} p/s | ${fmt(c.throughputPagesPerSec, 2)} p/s | ${ratioCell(cmp.throughputRatioVeloraOverChromium)} |`);
        lines.push(`| Mean latency (total) | ${fmt(v.meanMs)} ms | ${fmt(c.meanMs)} ms | ${ratioCell(cmp.meanLatencyRatio)} |`);
        lines.push(`| TTFX mean | ${fmt(v.meanTtfexMs)} ms | ${fmt(c.meanTtfexMs)} ms | ${ratioCell(cmp.meanTtfexRatio)} |`);
        lines.push(`| TTFX median | ${fmt(v.medianTtfexMs)} ms | ${fmt(c.medianTtfexMs)} ms | — |`);
        lines.push(`| DOM ready mean | ${fmt(v.meanDomReadyMs)} ms | ${fmt(c.meanDomReadyMs)} ms | — |`);
        lines.push(`| Peak RSS | ${miB(vr?.peakRssBytes)} | ${miB(cr?.peakRssBytes)} | ${ratioCell(cmp.peakRssRatio)} |`);
        lines.push(`| Avg RSS | ${miB(vr?.avgRssBytes)} | ${miB(cr?.avgRssBytes)} | ${ratioCell(cmp.avgRssRatio)} |`);
        lines.push(`| RSS / page | ${miB(vr?.rssPerPageBytes)} | ${miB(cr?.rssPerPageBytes)} | ${ratioCell(cmp.rssPerPageRatio)} |`);
        lines.push(`| **Sessions / GB** | ${vr?.sessionsPerGb ?? "n/a"} | ${cr?.sessionsPerGb ?? "n/a"} | ${ratioCell(cmp.sessionsPerGbRatio)} |`);
        lines.push(`| **CPU-sec / page** | ${fmt(vr?.cpuSecondsPerPage, 4)} | ${fmt(cr?.cpuSecondsPerPage, 4)} | ${ratioCell(cmp.cpuSecondsPerPageRatio)} |`);
        lines.push(`| Peak CPU (Σ%) | ${fmtCpu(vr?.peakCpuPercent)} | ${fmtCpu(cr?.peakCpuPercent)} | ${ratioCell(cmp.peakCpuRatio)} |`);
        lines.push(`| Avg CPU (Σ%) | ${fmtCpu(vr?.avgCpuPercent)} | ${fmtCpu(cr?.avgCpuPercent)} | ${ratioCell(cmp.avgCpuRatio)} |`);
        lines.push(`| CPU core-equivalent (avg) | ${fmt(vr?.cpuCoreEquivalents, 2)} | ${fmt(cr?.cpuCoreEquivalents, 2)} | ${ratioCell(cmp.avgCpuRatio)} |`);
        lines.push(`| Peak process count | ${vr?.peakProcessCount ?? "n/a"} | ${cr?.peakProcessCount ?? "n/a"} | ${ratioCell(cmp.peakProcessRatio)} |`);
        lines.push(`| GPU helper processes | ${vr?.peakGpuProcessCount ?? 0} | ${cr?.peakGpuProcessCount ?? 0} | — |`);
        lines.push(`| GPU helper RSS | ${miB(vr?.peakGpuRssBytes)} | ${miB(cr?.peakGpuRssBytes)} | — |`);
        lines.push(`| Success rate | ${v.success}/${v.pages} | ${c.success}/${c.pages} | — |`);
        lines.push("");

        lines.push(isFair ? "### Throughput takeaways" : "### Cost & density takeaways");
        lines.push("");
        if (cmp.veloraFaster) {
            lines.push(`- **Wall time:** Velora finished in ${fmt(v.wallMs, 0)} ms vs Chromium ${fmt(c.wallMs, 0)} ms.`);
        } else {
            lines.push(`- **Wall time:** Chromium finished in ${fmt(c.wallMs, 0)} ms vs Velora ${fmt(v.wallMs, 0)} ms.`);
        }
        if (cmp.veloraLowerMemory) {
            lines.push("- **Memory:** Velora peak RSS is lower at this concurrency.");
        } else {
            lines.push("- **Memory:** Chromium peak RSS is lower for this run.");
        }
        if (!isFair) {
            if (cmp.veloraHigherDensity) {
                lines.push(`- **Agent density:** Velora fits ~${vr?.sessionsPerGb ?? "?"} concurrent sessions per GB RAM vs Chromium ~${cr?.sessionsPerGb ?? "?"}.`);
            } else {
                lines.push(`- **Agent density:** Chromium fits more sessions per GB in this run (${cr?.sessionsPerGb ?? "?"} vs ${vr?.sessionsPerGb ?? "?"}).`);
            }
        } else if (meta.httpCacheEnabled) {
            lines.push(`- **HTTP cache:** enabled at \`${meta.httpCacheDir}\` — wiki skin/assets may be served from cache after warmup.`);
        }
        const vCpu = vr?.cpuSecondsPerPage;
        const cCpu = cr?.cpuSecondsPerPage;
        if (vCpu != null && cCpu != null) {
            const cheaper = vCpu < cCpu ? "Velora" : "Chromium";
            lines.push(`- **CPU cost per page:** ${cheaper} uses less CPU-sec/page (Velora ${fmt(vCpu, 4)} · Chromium ${fmt(cCpu, 4)}).`);
        }
        if (v.meanTtfexMs != null && c.meanTtfexMs != null) {
            const fasterTtfx = v.meanTtfexMs < c.meanTtfexMs ? "Velora" : "Chromium";
            lines.push(`- **TTFX (time to first extraction):** ${fasterTtfx} reaches first extractable element faster (Velora ${fmt(v.meanTtfexMs)} ms · Chromium ${fmt(c.meanTtfexMs)} ms).`);
        }
        lines.push(`- **Processes:** Velora runs ${v.parallelism} browser processes; Chromium packs ${c.parallelism} tabs into ~${cr?.peakProcessCount ?? "?"} OS processes (multi-process Chrome).`);
        lines.push("- **CPU:** Σ% can exceed 100% on multi-core; core-equivalent ≈ avg CPU% / 100.");
        lines.push("- **Cost model:** `tasks × cpu_sec_per_task × $/CPU-sec` + `sessions / sessions_per_GB × $/GB-RAM`.");
        lines.push("");
    }

    lines.push("## Planned benchmarks (AI browser runtime)");
    lines.push("");
    lines.push("| Suite | Workload | Key metrics |");
    lines.push("| --- | --- | --- |");
    lines.push("| Agent Search | 100 Google searches → open first result → extract | tasks/sec, CPU-sec/task, blocks, success rate |");
    lines.push("| Agent Density | sweep concurrency 1→32 in 1 GB RAM budget | sessions/GB curve |");
    lines.push("| Browser Compatibility | CreepJS, WPT, real sites | pass rate, fingerprint score |");
    lines.push("| Bot / Stealth | reCAPTCHA v3, Cloudflare, hCaptcha | score, block rate |");
    lines.push("| Agent Automation | 1000 form submissions | success rate, latency |");
    lines.push("| Hacker News / GitHub | live SERP-like pages | TTFX, extract latency |");
    lines.push("");

    for (const [label, s] of [["Velora", v], ["Chromium", c]]) {
        if (!s) continue;
        const r = res(s);
        lines.push(`## ${label} detail`);
        lines.push("");
        lines.push(`- Model: ${s.parallelismModel}, parallelism ${s.parallelism}`);
        lines.push(`- Wall: ${fmt(s.wallMs, 0)} ms · throughput ${fmt(s.throughputPagesPerSec, 2)} p/s`);
        lines.push(`- Latency mean/median: ${fmt(s.meanMs)} / ${fmt(s.medianMs)} ms`);
        if (s.meanTtfexMs != null) {
            lines.push(`- TTFX mean/median: ${fmt(s.meanTtfexMs)} / ${fmt(s.medianTtfexMs)} ms`);
            lines.push(`- DOM ready mean: ${fmt(s.meanDomReadyMs)} ms`);
        }
        if (r) {
            lines.push(`- Peak/avg RSS: ${miB(r.peakRssBytes)} / ${miB(r.avgRssBytes)}`);
            lines.push(`- RSS/page: ${miB(r.rssPerPageBytes)} · sessions/GB: ${r.sessionsPerGb ?? "n/a"}`);
            lines.push(`- CPU-sec/page: ${fmt(r.cpuSecondsPerPage, 4)} · integrated CPU: ${fmt(r.integratedCpuSeconds, 3)} s`);
            lines.push(`- Peak/avg CPU: ${fmtCpu(r.peakCpuPercent)} / ${fmtCpu(r.avgCpuPercent)}`);
            lines.push(`- Peak processes: ${r.peakProcessCount}`);
        }
        if (s.failures?.length) {
            lines.push("- Failures:");
            for (const f of s.failures) lines.push(`  - ${f.title}: ${f.error}`);
        }
        if (s.resources?.series?.length) {
            lines.push("");
            lines.push("<details><summary>Resource time series (downsampled)</summary>");
            lines.push("");
            lines.push("| t (ms) | RSS (MiB) | CPU Σ% | processes |");
            lines.push("| ---: | ---: | ---: | ---: |");
            for (const pt of s.resources.series) {
                lines.push(`| ${pt.tMs} | ${pt.rssMiB} | ${pt.cpuPct} | ${pt.procs} |`);
            }
            lines.push("");
            lines.push("</details>");
        }
        lines.push("");
    }

    lines.push("## Reproduce");
    lines.push("");
    lines.push("```bash");
    lines.push("zig build -Doptimize=ReleaseFast");
    lines.push("npx playwright install chromium");
    lines.push("# Agent density lane (default, unchanged)");
    lines.push("npm run bench:crawl:wikipedia:density:publish");
    lines.push("# Fair throughput lane (1 process + HTTP cache + warmup)");
    lines.push("npm run bench:crawl:wikipedia:fair:publish");
    lines.push("# Both lanes");
    lines.push("npm run bench:crawl:wikipedia:publish:all");
    lines.push("```");
    lines.push("");
    lines.push(`Raw JSON: \`${rawJsonPath}\``);
    lines.push("");

    return `${lines.join("\n")}\n`;
}

function renderHtml(report) {
    const meta = report.meta || {};
    const v = report.velora;
    const c = report.chromium;
    const cmp = report.comparison;
    const vr = res(v);
    const cr = res(c);
    const title = meta.benchmarkName || "Crawl benchmark";

    const metrics = [];
    if (cmp && v && c) {
        metrics.push(["Wall time", `${fmt(v.wallMs, 0)} ms`, `${fmt(c.wallMs, 0)} ms`, ratioCell(cmp.wallRatioVeloraOverChromium), ratioClass(cmp.wallRatioVeloraOverChromium)]);
        metrics.push(["Throughput", `${fmt(v.throughputPagesPerSec, 2)} p/s`, `${fmt(c.throughputPagesPerSec, 2)} p/s`, ratioCell(cmp.throughputRatioVeloraOverChromium), ratioClass(cmp.throughputRatioVeloraOverChromium, true)]);
        metrics.push(["Mean latency", `${fmt(v.meanMs)} ms`, `${fmt(c.meanMs)} ms`, ratioCell(cmp.meanLatencyRatio), ratioClass(cmp.meanLatencyRatio)]);
        metrics.push(["TTFX mean", `${fmt(v.meanTtfexMs)} ms`, `${fmt(c.meanTtfexMs)} ms`, ratioCell(cmp.meanTtfexRatio), ratioClass(cmp.meanTtfexRatio)]);
        metrics.push(["Peak RSS", miB(vr?.peakRssBytes), miB(cr?.peakRssBytes), ratioCell(cmp.peakRssRatio), ratioClass(cmp.peakRssRatio)]);
        metrics.push(["Sessions / GB", vr?.sessionsPerGb ?? "n/a", cr?.sessionsPerGb ?? "n/a", ratioCell(cmp.sessionsPerGbRatio), ratioClass(cmp.sessionsPerGbRatio, true)]);
        metrics.push(["CPU-sec / page", fmt(vr?.cpuSecondsPerPage, 4), fmt(cr?.cpuSecondsPerPage, 4), ratioCell(cmp.cpuSecondsPerPageRatio), ratioClass(cmp.cpuSecondsPerPageRatio)]);
        metrics.push(["Success", `${v.success}/${v.pages}`, `${c.success}/${c.pages}`, "—", ""]);
    }

    function perPageRows(engine) {
        if (!engine?.results) return "";
        return engine.results.map((r) => {
            const status = r.ok ? '<span class="ok">OK</span>' : `<span class="fail">${esc(r.error)}</span>`;
            const titleText = esc(r.title || r.url || `#${r.idx}`);
            const url = r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${titleText}</a>` : titleText;
            return row([
                r.idx,
                url,
                status,
                r.ttfexMs != null ? `${fmt(r.ttfexMs, 0)} ms` : "—",
                r.totalMs != null ? `${fmt(r.totalMs, 0)} ms` : `${fmt(r.ms, 0)} ms`,
                r.score ? esc(r.score) : "—",
            ]);
        }).join("\n");
    }

    const metricTable = metrics.length
        ? `<table class="metrics">
<thead>${row(["Metric", "Velora", "Chromium", "Ratio V/C", ""], "th")}</thead>
<tbody>
${metrics.map(([m, a, b, r, cls]) => row([m, a, b, `<span class="${cls}">${r}</span>`, ""])).join("\n")}
</tbody></table>`
        : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { --bg:#0f1117; --card:#1a1d27; --text:#e8eaed; --muted:#9aa0a6; --accent:#7cacf8; --good:#34d399; --bad:#f87171; --border:#2d3340; }
  * { box-sizing:border-box; }
  body { margin:0; font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); }
  .wrap { max-width:1100px; margin:0 auto; padding:32px 20px 64px; }
  h1 { font-size:1.6rem; margin:0 0 8px; }
  .meta { color:var(--muted); margin-bottom:28px; }
  h2 { font-size:1.1rem; margin:32px 0 12px; color:var(--accent); }
  .card { background:var(--card); border:1px solid var(--border); border-radius:10px; padding:16px 18px; margin-bottom:16px; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  th, td { padding:8px 10px; border-bottom:1px solid var(--border); text-align:left; }
  th { color:var(--muted); font-weight:600; }
  td:nth-child(n+3) { text-align:right; }
  th:nth-child(n+3) { text-align:right; }
  .good { color:var(--good); font-weight:600; }
  .bad { color:var(--bad); font-weight:600; }
  .neutral { color:var(--muted); }
  .ok { color:var(--good); }
  .fail { color:var(--bad); font-size:12px; }
  a { color:var(--accent); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  @media (max-width:800px) { .grid { grid-template-columns:1fr; } }
  .stat { font-size:1.4rem; font-weight:700; }
  .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(title)}</h1>
  <p class="meta">${esc(meta.timestamp)} · ${meta.limit} pages · concurrency ${meta.concurrency} · ${esc(meta.cpu)} · ${esc(meta.site)}</p>

  ${cmp ? `<div class="grid">
    <div class="card"><div class="label">Velora wall time</div><div class="stat">${fmt(v.wallMs, 0)} ms</div></div>
    <div class="card"><div class="label">Chromium wall time</div><div class="stat">${fmt(c.wallMs, 0)} ms</div></div>
    <div class="card"><div class="label">Velora throughput</div><div class="stat">${fmt(v.throughputPagesPerSec, 2)} p/s</div></div>
    <div class="card"><div class="label">Chromium throughput</div><div class="stat">${fmt(c.throughputPagesPerSec, 2)} p/s</div></div>
  </div>` : ""}

  <h2>Comparison</h2>
  <div class="card">${metricTable || "<p>No comparison data.</p>"}</div>

  ${v ? `<h2>Velora — per page</h2><div class="card"><table>
<thead>${row(["#", "Page", "Status", "TTFX", "Total", "Score"], "th")}</thead>
<tbody>${perPageRows(v)}</tbody></table></div>` : ""}

  ${c ? `<h2>Chromium — per page</h2><div class="card"><table>
<thead>${row(["#", "Page", "Status", "TTFX", "Total", "Score"], "th")}</thead>
<tbody>${perPageRows(c)}</tbody></table></div>` : ""}

  <p class="meta" style="margin-top:32px">Generated ${esc(new Date().toISOString())}</p>
</div>
</body>
</html>`;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!existsSync(opts.input)) {
        throw new Error(`Missing ${opts.input}. Run: npm run bench:crawl:wikipedia`);
    }
    const report = JSON.parse(readFileSync(opts.input, "utf8"));
    if (!existsSync(docsDir)) mkdirSync(docsDir, { recursive: true });
    const prefix = opts.outputPrefix || (report.meta?.site?.includes("ycombinator") ? "crawl-hn" : "crawl-wikipedia");

    if (opts.format === "html") {
        const html = renderHtml(report);
        const out = resolve(docsDir, `${prefix}.html`);
        writeFileSync(out, html);
        console.log(`saved: ${out}`);
        return;
    }

    const md = render(report, opts.input);
    const latest = resolve(docsDir, `${prefix}-latest.md`);
    const dated = resolve(docsDir, `${prefix}-${report.meta?.timestamp?.slice(0, 10) || "run"}.md`);
    writeFileSync(latest, md);
    writeFileSync(dated, md);
    console.log(`saved: ${latest}`);
    console.log(`saved: ${dated}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});