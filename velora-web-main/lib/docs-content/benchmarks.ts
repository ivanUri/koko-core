import type { DocPageMap } from "./types";

export const benchmarkPages: DocPageMap = {
  microbench: {
    slug: "microbench",
    title: "Microbench (local fixtures)",
    description: "Velora vs Playwright Chromium on startup, navigation, and JS workloads.",
    categoryId: 5,
    content: `
<p>Microbench compares Velora against <strong>Playwright bundled Chromium</strong> (headless) on local static HTML fixtures in <code>velora-test/</code>. Last run: <strong>2026-06-29</strong>.</p>

<h2>Executive summary</h2>
<ul>
  <li><strong>Host:</strong> Apple M1, macOS 24.3.0, Node v22.19.0</li>
  <li><strong>Velora profile:</strong> <code>chrome-macos-catalina</code></li>
  <li><strong>Startup ratio (V/C):</strong> <strong>1.01×</strong> (+1.3% vs Chromium)</li>
  <li><strong>Navigation geomean ratio:</strong> <strong>0.22×</strong> (−78% vs Chromium — Velora faster)</li>
  <li><strong>JS workload geomean ratio:</strong> <strong>1.20×</strong> (+20% vs Chromium)</li>
</ul>
<p>Ratio <strong>&gt; 1.0</strong> means Velora is slower; <strong>&lt; 1.0</strong> means Velora is faster.</p>

<h2>Cold start</h2>
<table>
  <thead><tr><th>Browser</th><th>Mean (ms)</th><th>Median (ms)</th></tr></thead>
  <tbody>
    <tr><td>Velora</td><td>105.6</td><td>105.8</td></tr>
    <tr><td>Chromium</td><td>104.3</td><td>104.6</td></tr>
    <tr><td><strong>Ratio</strong></td><td><strong>1.01×</strong></td><td></td></tr>
  </tbody>
</table>

<h2>Static page navigation</h2>
<p>Warmup: 1 · Measured repeats: 3 · Wait: <code>domcontentloaded</code></p>
<table>
  <thead><tr><th>Page</th><th>Velora mean</th><th>Chromium mean</th><th>Ratio</th></tr></thead>
  <tbody>
    <tr><td><code>dom-heavy.html</code></td><td>19.9 ms</td><td>72.7 ms</td><td>0.27×</td></tr>
    <tr><td><code>js-compute.html</code></td><td>8.1 ms</td><td>37.9 ms</td><td>0.21×</td></tr>
    <tr><td><code>minimal.html</code></td><td>8.1 ms</td><td>37.9 ms</td><td>0.21×</td></tr>
    <tr><td><code>mixed.html</code></td><td>9.4 ms</td><td>48.7 ms</td><td>0.19×</td></tr>
  </tbody>
</table>
<p><strong>Geomean ratio:</strong> 0.22×</p>

<h2>In-page JS workloads</h2>
<table>
  <thead><tr><th>Workload</th><th>Page</th><th>Velora</th><th>Chromium</th><th>Ratio</th></tr></thead>
  <tbody>
    <tr><td>dom-query</td><td>dom-heavy.html</td><td>0.3 ms</td><td>0.2 ms</td><td>1.69×</td></tr>
    <tr><td>json-loop</td><td>js-compute.html</td><td>3.3 ms</td><td>2.7 ms</td><td>1.22×</td></tr>
    <tr><td>hash-loop</td><td>js-compute.html</td><td>1.2 ms</td><td>1.4 ms</td><td>0.84×</td></tr>
  </tbody>
</table>
<p><strong>Geomean ratio:</strong> 1.20×</p>

<h2>Takeaway</h2>
<p>Velora is dramatically faster on static navigation (local fixtures) with comparable startup. In-page JS micro-workloads are slightly slower on average — acceptable trade-off for lower memory footprint at scale.</p>
`,
  },

  "crawl-wikipedia": {
    slug: "crawl-wikipedia",
    title: "Wikipedia crawl",
    description: "Real-world crawl benchmark: 100 Wikipedia articles at concurrency 8.",
    categoryId: 5,
    content: `
<p>Real-world crawl benchmark against live <strong>en.wikipedia.org</strong>. Last run: <strong>2026-06-29</strong> · 100 pages · concurrency 8 · Apple M1.</p>

<h2>What this measures</h2>
<ul>
  <li><strong>Class:</strong> <code>crawler-runtime</code> — network → HTML parse → DOM extract</li>
  <li><strong>Mode:</strong> <code>extract</code> (title + wiki links via <code>querySelector</code>)</li>
  <li><strong>Velora:</strong> 8× <code>velora serve</code> (multi-process)</li>
  <li><strong>Chromium:</strong> 8 tabs, 1 browser (multi-tab-single-process)</li>
</ul>

<h2>Architecture note</h2>
<p>Peak process count and peak RSS are <strong>not apples-to-apples</strong> across architectures. Use <strong>RSS/page</strong>, <strong>sessions/GB</strong>, and <strong>CPU-sec/page</strong> for cost comparisons.</p>

<h2>Scalability comparison</h2>
<table>
  <thead><tr><th>Metric</th><th>Velora</th><th>Chromium</th><th>Ratio (V/C)</th></tr></thead>
  <tbody>
    <tr><td>Wall time</td><td>8911 ms</td><td>11965 ms</td><td>0.74×</td></tr>
    <tr><td>Throughput</td><td>11.22 p/s</td><td>8.36 p/s</td><td>1.34×</td></tr>
    <tr><td>Mean latency</td><td>648.0 ms</td><td>829.4 ms</td><td>0.78×</td></tr>
    <tr><td>TTFX mean</td><td>648.0 ms</td><td>751.8 ms</td><td>0.86×</td></tr>
    <tr><td>Peak RSS</td><td>852.8 MiB</td><td>2988.0 MiB</td><td>0.29×</td></tr>
    <tr><td>RSS / page</td><td>8.5 MiB</td><td>29.9 MiB</td><td>0.29×</td></tr>
    <tr><td><strong>Sessions / GB</strong></td><td><strong>9</strong></td><td><strong>2</strong></td><td>4.50×</td></tr>
    <tr><td>CPU-sec / page</td><td>0.0883</td><td>0.1510</td><td>0.58×</td></tr>
    <tr><td>Success rate</td><td>100/100</td><td>100/100</td><td>—</td></tr>
  </tbody>
</table>

<h2>Cost &amp; density takeaways</h2>
<ul>
  <li><strong>Memory:</strong> Velora peak RSS ~3× lower — better footprint per crawl worker</li>
  <li><strong>Agent density:</strong> ~9 concurrent sessions per GB RAM vs Chromium ~2</li>
  <li><strong>CPU cost:</strong> 0.088 vs 0.151 CPU-sec/page</li>
  <li><strong>TTFX:</strong> Velora reaches first extractable element faster</li>
</ul>

<h2>Limitations</h2>
<p>Wikipedia articles are mostly static HTML. This workload does <strong>not</strong> stress WebGL, SPA routing, React hydration, service workers, or bot detection.</p>
`,
  },

  reproduce: {
    slug: "reproduce",
    title: "Reproduce locally",
    description: "Commands to run Velora benchmarks on your machine.",
    categoryId: 5,
    content: `
<p>All benchmarks run locally from the Velora repo. Results are machine-specific — compare trends, not absolute numbers across hardware.</p>

<h2>Prerequisites</h2>
<pre><code>zig build
npx playwright install chromium   # first time only
npm run build:sdk                 # auto-run before bench scripts</code></pre>

<h2>Microbench (local fixtures)</h2>
<pre><code>npm run bench:compare:publish</code></pre>
<p>Runs comparison and writes report to <code>docs/benchmarks/latest.md</code>. Raw JSON: <code>code-check/tmp/benchmarks/run.json</code>.</p>

<h2>Wikipedia crawl</h2>
<pre><code>npm run bench:crawl:wikipedia:publish</code></pre>
<p>100 live Wikipedia URLs at concurrency 8. Report: <code>docs/benchmarks/crawl-wikipedia-latest.md</code>.</p>

<h2>Density sweep</h2>
<pre><code>npm run bench:density:publish</code></pre>
<p>Concurrency sweep for sessions-per-GB curves.</p>

<h2>Google agent compare</h2>
<pre><code>npm run bench:google:agent:publish</code></pre>
<p>Agent-style Google search workflows (when configured).</p>

<h2>Full suite</h2>
<pre><code>npm run bench:suite</code></pre>

<h2>Fixtures</h2>
<p>Local static pages in <code>velora-test/</code>:</p>
<ul>
  <li><code>minimal.html</code> — bare page</li>
  <li><code>dom-heavy.html</code> — large DOM for query benchmarks</li>
  <li><code>js-compute.html</code> — JSON/hash loops</li>
  <li><code>mixed.html</code> — combined workload</li>
</ul>

<h2>Historical reports</h2>
<p>Dated snapshots in <code>docs/benchmarks/</code> — e.g. <code>2026-06-29.md</code>.</p>
`,
  },

  methodology: {
    slug: "methodology",
    title: "Methodology & limitations",
    description: "How benchmarks are run, what they measure, and what they do not.",
    categoryId: 5,
    content: `
<p>Velora benchmarks compare against <strong>Playwright bundled Chromium</strong> (headless) — not Google Chrome desktop. Numbers are machine-local and intended for regression tracking, not marketing absolutes.</p>

<h2>Microbench methodology</h2>
<ul>
  <li><strong>Velora:</strong> <code>zig-out/bin/velora serve</code> + CDP navigation/evaluate</li>
  <li><strong>Chromium:</strong> <code>chromium.launch({ headless: true })</code></li>
  <li><strong>Fixtures:</strong> local static HTML in <code>velora-test/</code> (no CDN)</li>
  <li><strong>Navigation metric:</strong> <code>Page.navigate</code> / <code>goto</code> until <code>domcontentloaded</code> + DOM size probe</li>
  <li><strong>JS metric:</strong> in-page <code>performance.now()</code> for dom-query, JSON loop, FNV-style hash loop</li>
  <li><strong>Startup metric:</strong> process spawn until browser ready (Velora: <code>/json/version</code>; Chromium: launch + <code>about:blank</code>)</li>
  <li><strong>Startup warmup/repeats:</strong> 2/5</li>
</ul>

<h2>Crawl methodology</h2>
<ul>
  <li><strong>Site:</strong> live en.wikipedia.org (100 shared URLs)</li>
  <li><strong>Mode:</strong> extract — title + links via <code>querySelector</code></li>
  <li><strong>Concurrency:</strong> 8 parallel workers</li>
  <li><strong>Resource sampling:</strong> every 100ms via process tree (RSS, CPU%, process count)</li>
  <li><strong>Velora:</strong> 8 isolated <code>velora serve</code> processes</li>
  <li><strong>Chromium:</strong> 8 tabs in 1 browser process tree</li>
</ul>

<h2>Limitations</h2>
<ul>
  <li>Single-machine runs — CPU load affects numbers</li>
  <li>Local static pages do not represent heavy SPAs or real sites</li>
  <li>Playwright Chromium ≠ installed Google Chrome</li>
  <li>Wikipedia crawl does not stress WebGL, hydration, or bot detection</li>
  <li>Process count comparisons are architectural, not fairness claims</li>
  <li>GPU utilization not available headless</li>
</ul>

<h2>Interpreting ratios</h2>
<p>Ratio <strong>Velora / Chromium</strong>:</p>
<ul>
  <li><strong>&lt; 1.0</strong> — Velora uses less (better for memory/CPU/time)</li>
  <li><strong>&gt; 1.0</strong> — Velora uses more</li>
</ul>

<h2>Cost model</h2>
<pre><code>total_cost = tasks × cpu_sec_per_task × $/CPU-sec
           + sessions / sessions_per_GB × $/GB-RAM</code></pre>

<p>Velora's lower RSS/page and higher sessions/GB directly reduce RAM cost for agent pools and crawl fleets.</p>
`,
  },
};