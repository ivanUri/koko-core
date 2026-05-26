#!/usr/bin/env node
// Fetch a wpt.fyi result page through the public API and export a compact HTML report.

const { existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const repoRoot = resolve(__dirname, "..");
const outputDir = resolve(repoRoot, "code-check/tmp/output");

const defaults = {
    products: ["chrome", "firefox", "safari"],
};

function usage() {
    return `Usage: node code-check/wpt-fyi-check.js <wpt.fyi results URL>

The script derives path, labels, products, and output filename from the URL.
If the URL has no product= query params, it uses: ${defaults.products.join(", ")}

Example:
  node code-check/wpt-fyi-check.js "https://wpt.fyi/results/dom/lists?label=experimental&label=master&aligned"
  node code-check/wpt-fyi-check.js "https://wpt.fyi/results/js?label=master&label=experimental&aligned"
`;
}

function parseArgs(argv) {
    if (argv.includes("--help") || argv.includes("-h")) return { help: true };
    if (argv.length !== 1) throw new Error("Pass exactly one wpt.fyi results URL");

    const url = new URL(argv[0]);
    if (url.hostname !== "wpt.fyi" || !url.pathname.startsWith("/results/")) {
        throw new Error("URL must look like https://wpt.fyi/results/<path>?...");
    }

    const path = `/${decodeURIComponent(url.pathname.slice("/results/".length))}`;
    const products = url.searchParams.getAll("product");
    return {
        url: url.toString(),
        path,
        products: products.length > 0 ? products : [...defaults.products],
        output: resolve(outputDir, `wpt-fyi-${slugifyPath(path)}.html`),
    };
}

function slugifyPath(path) {
    return path.replace(/^\/+/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root";
}

function readUrlOptions(sourceUrl) {
    const parsed = new URL(sourceUrl);
    const labels = parsed.searchParams.getAll("label");
    return {
        labels: labels.length > 0 ? labels : ["master"],
        aligned: parsed.searchParams.has("aligned"),
    };
}

async function fetchJson(url) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
}

async function loadRuns(options) {
    const pageOptions = readUrlOptions(options.url);
    const params = new URLSearchParams();
    for (const label of pageOptions.labels) params.append("label", label);
    for (const product of options.products) params.append("product", product);
    if (pageOptions.aligned) params.set("aligned", "true");

    const runsUrl = `https://wpt.fyi/api/runs?${params}`;
    const runs = await fetchJson(runsUrl);
    if (!Array.isArray(runs) || runs.length === 0) throw new Error(`No runs returned from ${runsUrl}`);
    return { runsUrl, runs };
}

async function loadSearch(options, runs) {
    const runIds = runs.map((run) => run.id).filter(Boolean);
    if (runIds.length === 0) throw new Error("No run IDs found in wpt.fyi /api/runs response");

    const params = new URLSearchParams();
    params.set("run_ids", runIds.join(","));
    params.set("q", options.path);

    const searchUrl = `https://wpt.fyi/api/search?${params}`;
    const search = await fetchJson(searchUrl);
    return { searchUrl, search };
}

function statusFromResult(result) {
    if (!result) return { label: "MISSING", className: "missing", pass: 0, total: 0, percent: 0 };

    const counts = result.counts || {};
    const pass = Number(result.passes ?? counts.PASS ?? counts.OK ?? 0);
    const total = Number(result.total ?? Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0));
    const percent = total > 0 ? Math.round((pass / total) * 1000) / 10 : 0;
    const label = total === 0 ? result.status || "UNKNOWN" : `${pass}/${total} (${percent}%)`;
    const className = total === 0 ? "unknown" : percent === 100 ? "pass" : percent > 0 ? "mixed" : "fail";
    return { label, className, pass, total, percent };
}

function summarize(search, runs) {
    const productByRunId = new Map(runs.map((run) => [run.id, run.browser_name || run.product || `run ${run.id}`]));
    const products = runs.map((run) => ({ id: run.id, name: productByRunId.get(run.id), labels: run.labels || [], revision: run.revision || "" }));
    const rows = (search.results || []).map((item) => {
        const perRun = new Map((item.legacy_status || []).map((result, index) => [result.run_id || products[index]?.id, statusFromResult(result)]));
        return {
            test: item.test || item.test_id || "(unknown test)",
            subtest: item.subtest || "",
            results: products.map((product) => perRun.get(product.id) || statusFromResult(null)),
        };
    });

    const totals = products.map((_, index) => {
        let pass = 0;
        let total = 0;
        for (const row of rows) {
            pass += row.results[index].pass;
            total += row.results[index].total;
        }
        const percent = total > 0 ? Math.round((pass / total) * 1000) / 10 : 0;
        return { pass, total, percent };
    });

    return { products, rows, totals };
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;",
    }[ch]));
}

function renderHtml({ options, runsUrl, searchUrl, summary }) {
    const generatedAt = new Date().toISOString();
    const productHeaders = summary.products.map((product) => `<th>${escapeHtml(product.name)}<small>run ${product.id}</small></th>`).join("\n");
    const totalCells = summary.totals.map((total) => `<td class="total"><strong>${total.pass}/${total.total}</strong><span>${total.percent}% pass</span></td>`).join("\n");
    const rows = summary.rows.map((row) => {
        const resultCells = row.results.map((result) => `<td class="${result.className}">${escapeHtml(result.label)}</td>`).join("\n");
        return `<tr>
            <td class="test"><code>${escapeHtml(row.test)}</code>${row.subtest ? `<span>${escapeHtml(row.subtest)}</span>` : ""}</td>
            ${resultCells}
        </tr>`;
    }).join("\n");

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>WPT Results - ${escapeHtml(options.path)}</title>
<style>
:root { color-scheme: light; --ink: #17211b; --muted: #637065; --line: #d8e0d8; --paper: #fbfaf4; --panel: #ffffff; --pass: #d9f2df; --mixed: #fff0bf; --fail: #ffd9d4; --missing: #eceff1; }
body { margin: 0; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: radial-gradient(circle at 20% 0%, #e5f3dd 0, transparent 34rem), linear-gradient(135deg, #fbfaf4, #eef4ec); }
main { max-width: 1180px; margin: 0 auto; padding: 40px 20px 64px; }
h1 { margin: 0 0 8px; font-size: clamp(30px, 5vw, 58px); letter-spacing: -0.055em; }
.lead { max-width: 780px; color: var(--muted); line-height: 1.55; }
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 24px 0; }
.card { background: rgba(255,255,255,0.78); border: 1px solid var(--line); border-radius: 18px; padding: 14px 16px; box-shadow: 0 18px 45px rgba(40, 55, 39, 0.08); }
.card strong { display: block; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
.card span, .card a { color: var(--ink); overflow-wrap: anywhere; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 20px; background: var(--panel); box-shadow: 0 22px 60px rgba(40, 55, 39, 0.1); }
table { width: 100%; border-collapse: collapse; min-width: 820px; }
th, td { padding: 12px 14px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { position: sticky; top: 0; background: #f5f7ef; font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; }
th small { display: block; margin-top: 3px; color: var(--muted); text-transform: none; letter-spacing: 0; }
tbody tr:hover { background: #fafcf6; }
.test { width: 48%; }
.test code { white-space: normal; overflow-wrap: anywhere; font-size: 12px; }
.test span { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; }
.pass { background: var(--pass); }
.mixed { background: var(--mixed); }
.fail { background: var(--fail); }
.missing, .unknown { background: var(--missing); color: var(--muted); }
.total strong { display: block; }
.total span { color: var(--muted); font-size: 12px; }
footer { margin-top: 18px; color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<main>
<h1>WPT Results: ${escapeHtml(options.path)}</h1>
<p class="lead">Generated from wpt.fyi public API for the page <a href="${escapeHtml(options.url)}">${escapeHtml(options.url)}</a>.</p>
<section class="meta">
    <div class="card"><strong>Generated</strong><span>${escapeHtml(generatedAt)}</span></div>
    <div class="card"><strong>Tests</strong><span>${summary.rows.length}</span></div>
    <div class="card"><strong>Runs API</strong><a href="${escapeHtml(runsUrl)}">open</a></div>
    <div class="card"><strong>Search API</strong><a href="${escapeHtml(searchUrl)}">open</a></div>
</section>
<div class="table-wrap">
<table>
<thead>
<tr><th>Test</th>${productHeaders}</tr>
<tr><th>Total</th>${totalCells}</tr>
</thead>
<tbody>
${rows || `<tr><td colspan="${summary.products.length + 1}">No results returned.</td></tr>`}
</tbody>
</table>
</div>
<footer>Source: wpt.fyi API. Counts are rendered from each result's status counts when available.</footer>
</main>
</body>
</html>
`;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        console.log(usage());
        return;
    }
    if (!existsSync(resolve(options.output, ".."))) mkdirSync(resolve(options.output, ".."), { recursive: true });

    const { runsUrl, runs } = await loadRuns(options);
    const { searchUrl, search } = await loadSearch(options, runs);
    const summary = summarize(search, runs);
    const html = renderHtml({ options, runsUrl, searchUrl, summary });
    writeFileSync(options.output, html);

    console.log(`wpt.fyi path: ${options.path}`);
    console.log(`runs: ${runs.length}`);
    console.log(`tests: ${summary.rows.length}`);
    console.log(`saved html: ${options.output}`);
}

main().catch((err) => {
    console.error(err.stack || err.message);
    process.exitCode = 1;
});