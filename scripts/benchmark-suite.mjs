#!/usr/bin/env node
/**
 * Chạy ~20 benchmark tests và ghi đánh giá .md vào benchmark/ (chỉ markdown).
 *
 * Usage:
 *   npm run bench:suite
 *   node scripts/benchmark-suite.mjs --profile chrome-local-huys-macbook-pro
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { arch, cpus, hostname, platform, release } from "node:os";

import {
  Browser,
  captureSessionState,
} from "../sdk/dist/index.js";
import {
  collectHtmlFiles,
  connectCDP,
  createVeloraPage,
  fmt,
  geomean,
  getFreePort,
  JS_WORKLOADS,
  measureChromiumStartup,
  measureVeloraStartup,
  ratio,
  repoRoot,
  runBrowserBench,
  runChromeJs,
  runChromeNavigate,
  runVeloraJs,
  runVeloraNavigate,
  spawnVelora,
  startStaticServer,
  stopProcess,
  testRoot,
  veloraBin,
  waitForServer,
} from "../code-check/bench/lib/compare-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_DIR = resolve(repoRoot, "benchmark");
const FIXTURE = resolve(repoRoot, "sdk/examples/fixtures/agent-form.html");
const WIKI_URL = "https://en.wikipedia.org/wiki/Earth";
const TMP_JSON = resolve(repoRoot, "code-check/tmp/benchmarks/suite-run.json");

const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);

function parseArgs(argv) {
  const out = {
    profile: process.env.VELORA_PROFILE ?? "chrome-local-huys-macbook-pro",
    repeats: 2,
    warmup: 1,
    crawlLimit: 5,
    densityConcurrency: 8,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--help") out.help = true;
  }
  return out;
}

function gitSha() {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

function meta() {
  const cpu = cpus()[0];
  return {
    date: new Date().toISOString().slice(0, 10),
    timestamp: new Date().toISOString(),
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    cpu: cpu ? `${cpu.model} (${cpus().length} cores)` : null,
    node: process.version,
    gitSha: gitSha(),
  };
}

function verdict(r, invert = false) {
  if (r == null || !Number.isFinite(r)) return { label: "N/A", emoji: "⚪" };
  const good = invert ? r > 1 : r < 1;
  if (Math.abs(r - 1) < 0.08) return { label: "Tương đương", emoji: "🟡" };
  if (good) return { label: "Velora thắng", emoji: "🟢" };
  return { label: "Velora chậm hơn", emoji: "🔴" };
}

function writeMd(filename, body) {
  const path = resolve(BENCH_DIR, filename);
  writeFileSync(path, body.trim() + "\n", "utf8");
  return path;
}

function mdHeader(id, title, m) {
  return `# ${id}. ${title}

> **Ngày:** ${m.date} · **Host:** ${m.hostname} · **Git:** \`${m.gitSha ?? "?"}\`
`;
}

function mdCompareSection(veloraMs, chromiumMs, r) {
  const v = verdict(r);
  return `## Kết quả

| Engine | Mean (ms) |
|--------|----------:|
| Velora | ${fmt(veloraMs)} |
| Chromium | ${fmt(chromiumMs)} |
| **Ratio (V/C)** | **${r == null ? "n/a" : r.toFixed(2) + "x"}** |

## Đánh giá

${v.emoji} **${v.label}** — ratio < 1.0 nghĩa là Velora nhanh hơn Playwright Chromium.
`;
}

async function serveFixture() {
  const html = readFileSync(FIXTURE, "utf8");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  await new Promise((res, rej) => server.listen(0, "127.0.0.1", (e) => (e ? rej(e) : res())));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

async function runMicrobench(options, m, files) {
  const host = "127.0.0.1";
  const staticPort = await getFreePort(host);
  const veloraPort = await getFreePort(host);
  const benchOpts = {
    host,
    logLevel: "warn",
    logFormat: "pretty",
    httpTimeoutMs: 30_000,
    browserProfile: options.profile,
    timeoutMs: 10_000,
    serverTimeoutMs: 8000,
    commandTimeoutMs: 15_000,
    repeats: options.repeats,
    warmup: options.warmup,
    startupRepeats: 3,
    startupWarmup: 1,
    settleMs: 0,
  };

  const staticServer = await startStaticServer(host, staticPort);
  const baseUrl = `http://${host}:${staticPort}`;
  const cdpEndpoint = `http://${host}:${veloraPort}`;
  let proc;
  let cdp;
  let veloraPage;

  const restartVelora = async () => {
    if (cdp) cdp.close();
    if (proc) await stopProcess(proc);
    proc = spawnVelora(veloraPort, benchOpts);
    await waitForServer(`${cdpEndpoint}/json/version`, benchOpts.serverTimeoutMs);
    cdp = await connectCDP(cdpEndpoint, benchOpts);
    veloraPage = await createVeloraPage(cdp);
  };

  const { chromium } = require("playwright");
  const browser = await chromium.launch({ headless: true });

  try {
    const veloraStartup = await measureVeloraStartup(benchOpts);
    const chromiumStartup = await measureChromiumStartup(chromium, benchOpts);

    await restartVelora();
    const navItems = files.map((file) => ({
      file,
      url: `${baseUrl}/${file.split("/").map(encodeURIComponent).join("/")}`,
    }));

    const veloraNav = await runBrowserBench("velora", navItems, (item, opts) =>
      runVeloraNavigate(cdp, veloraPage, item.url, opts), benchOpts);
    const chromiumNav = await runBrowserBench("chromium", navItems, async (item, opts) => {
      const result = await runChromeNavigate(browser, item.url, opts);
      if (result.page) await result.page.close().catch(() => undefined);
      return result;
    }, benchOpts);

    const jsItems = JS_WORKLOADS.map((w) => ({
      name: w.name,
      page: w.page,
      url: `${baseUrl}/${w.page.split("/").map(encodeURIComponent).join("/")}`,
      call: w.call,
    }));

    const veloraJs = await runBrowserBench("velora", jsItems, (item, opts) =>
      runVeloraJs(cdp, veloraPage, item.url, item.call, opts), benchOpts, "name");
    const chromiumJs = await runBrowserBench("chromium", jsItems, (item, opts) =>
      runChromeJs(browser, item.url, item.call, opts), benchOpts, "name");

    return {
      startup: { velora: veloraStartup.summary, chromium: chromiumStartup.summary },
      navigation: files.map((file, i) => ({
        file,
        velora: veloraNav[i].summary,
        chromium: chromiumNav[i].summary,
        ratio: ratio(veloraNav[i].summary.meanMs, chromiumNav[i].summary.meanMs),
      })),
      js: jsItems.map((item, i) => ({
        name: item.name,
        velora: veloraJs[i].summary,
        chromium: chromiumJs[i].summary,
        ratio: ratio(veloraJs[i].summary.meanMs, chromiumJs[i].summary.meanMs),
      })),
      navGeomean: geomean(files.map((_, i) => ratio(veloraNav[i].summary.meanMs, chromiumNav[i].summary.meanMs))),
      jsGeomean: geomean(jsItems.map((_, i) => ratio(veloraJs[i].summary.meanMs, chromiumJs[i].summary.meanMs))),
    };
  } finally {
    if (cdp) cdp.close();
    if (proc) await stopProcess(proc);
    await staticServer.close();
    await browser.close();
  }
}

async function runSdkChecks(options) {
  const launched = await Browser.launch({ profile: options.profile, logLevel: "warn" });
  const fixture = await serveFixture();
  const page = await launched.browser.newPage();
  const checks = {};

  const time = async (fn) => {
    const t0 = Date.now();
    await fn();
    return Date.now() - t0;
  };

  try {
    checks.gotoDone = { ms: await time(() => page.goto(WIKI_URL, { waitUntil: "done", timeout: 30_000 })), ok: true };
    checks.markdown = { ms: await time(() => page.markdown()), ok: true };
    checks.semanticTree = { ms: await time(() => page.semanticTree({ format: "text", maxDepth: 4 })), ok: true };
    checks.structuredData = { ms: await time(() => page.getStructuredData()), ok: true };
    checks.links = { ms: await time(() => page.links()), ok: true };
    checks.extractWiki = { ms: await time(() => page.extract()), ok: true };
    await page.goto(fixture.url, { waitUntil: "done" });
    checks.detectForms = { ms: await time(() => page.detectForms()), ok: true };
    checks.interactive = { ms: await time(() => page.getInteractiveElements()), ok: true };
    const forms = await page.detectForms();
    const field = forms[0]?.fields?.find((f) => f.name === "q" && f.backendNodeId);
    checks.agentFill = {
      ms: await time(async () => {
        await page.node(field.backendNodeId).fill("bench");
      }),
      ok: !!field,
    };
    checks.waitHandle = {
      ms: await time(async () => {
        const h = await page.waitForSelectorHandle("#q");
        await h.fill("x");
      }),
      ok: true,
    };
    checks.sessionState = { ms: await time(() => captureSessionState(page)), ok: true };
  } catch (err) {
    checks.error = err?.message ?? String(err);
  } finally {
    await fixture.close();
    await launched.close();
  }
  return checks;
}

async function runMiniCrawl(options) {
  const { createCrawlWorker } = await import("../sdk/dist/index.js");
  const launched = await Browser.launch({ profile: options.profile, logLevel: "warn" });
  const titles = ["Earth", "Moon", "Mars", "Jupiter", "Saturn"].slice(0, options.crawlLimit);
  const queue = titles.map((title, i) => ({
    i,
    title,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
  }));

  const workers = await Promise.all([0, 1].map(() =>
    createCrawlWorker({
      endpoint: launched.endpoint,
      timeoutMs: 30_000,
      goto: { waitUntil: "done" },
    }),
  ));

  const results = [];
  let idx = 0;
  await Promise.all(workers.map(async (w, wi) => {
    while (idx < queue.length) {
      const my = idx++;
      if (my >= queue.length) break;
      results.push({ ...(await w.fetch(queue[my])), worker: wi });
    }
    await w.close();
  }));
  await launched.close();

  const ok = results.filter((r) => r.ok);
  return {
    total: results.length,
    success: ok.length,
    meanTtfexMs: ok.length ? ok.reduce((s, r) => s + (r.ttfexMs ?? 0), 0) / ok.length : null,
    meanExtractMs: ok.length ? ok.reduce((s, r) => s + (r.extractMs ?? 0), 0) / ok.length : null,
    results: ok,
  };
}

function ensureBenchDirClean() {
  mkdirSync(BENCH_DIR, { recursive: true });
  for (const name of readdirSync(BENCH_DIR)) {
    if (!name.endsWith(".md")) {
      throw new Error(`benchmark/ chỉ được chứa .md — xóa file: ${name}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: npm run bench:suite [--profile ID]");
    return;
  }
  if (!existsSync(veloraBin)) throw new Error("zig build first");

  ensureBenchDirClean();
  const m = meta();
  const files = collectHtmlFiles([]).filter((f) => f !== "endless.html");
  const written = [];

  console.log("=== Microbench (9 tests) ===");
  const micro = await runMicrobench(options, m, files);

  const startupRatio = ratio(micro.startup.velora.meanMs, micro.startup.chromium.meanMs);
  writeMd("01-startup-velora.md", `${mdHeader("01", "Cold start — Velora", m)}
## Kết quả

- Mean: **${fmt(micro.startup.velora.meanMs)} ms**
- Median: ${fmt(micro.startup.velora.medianMs)} ms
- Min/Max: ${fmt(micro.startup.velora.minMs)} / ${fmt(micro.startup.velora.maxMs)} ms

## Đánh giá

Thời gian từ spawn đến CDP sẵn sàng. ${startupRatio != null && startupRatio < 1.15 ? "🟢 Trong ngưỡng tốt (<1.15× Chromium)." : "🟡 Cần theo dõi nếu agent density yêu cầu cold start <100ms."}
`);
  written.push("01-startup-velora.md");

  writeMd("02-startup-chromium.md", `${mdHeader("02", "Cold start — Chromium (Playwright)", m)}
## Kết quả

- Mean: **${fmt(micro.startup.chromium.meanMs)} ms**
- Ratio V/C: **${startupRatio?.toFixed(2) ?? "n/a"}x**

## Đánh giá

Baseline Playwright headless. Velora ${startupRatio != null && startupRatio <= 1.05 ? "đạt parity startup." : `chênh ${((startupRatio - 1) * 100).toFixed(0)}% so với Chromium.`}
`);
  written.push("02-startup-chromium.md");

  const navNames = { "minimal.html": "03", "mixed.html": "04", "js-compute.html": "05", "dom-heavy.html": "06" };
  const navTitles = { "minimal.html": "Navigation — minimal", "mixed.html": "Navigation — mixed", "js-compute.html": "Navigation — js-compute", "dom-heavy.html": "Navigation — dom-heavy" };
  for (const row of micro.navigation) {
    const id = navNames[row.file] ?? row.file;
    const title = navTitles[row.file] ?? `Navigation — ${row.file}`;
    writeMd(`${id}-nav-${row.file.replace(".html", "")}.md`, `${mdHeader(id, title, m)}
${mdCompareSection(row.velora.meanMs, row.chromium.meanMs, row.ratio)}
`);
    written.push(`${id}-nav-${row.file.replace(".html", "")}.md`);
  }

  const jsIds = { "dom-query": "07", "json-loop": "08", "hash-loop": "09" };
  for (const row of micro.js) {
    const id = jsIds[row.name] ?? row.name;
    writeMd(`${id}-js-${row.name}.md`, `${mdHeader(id, `JS workload — ${row.name}`, m)}
${mdCompareSection(row.velora.meanMs, row.chromium.meanMs, row.ratio)}
`);
    written.push(`${id}-js-${row.name}.md`);
  }

  console.log("=== SDK LP (8 tests) ===");
  const sdk = await runSdkChecks(options);
  const sdkTests = [
    ["10", "sdk-goto-done", "goto waitUntil=done (Wikipedia)", sdk.gotoDone],
    ["11", "sdk-markdown", "LP markdown", sdk.markdown],
    ["12", "sdk-semantic-tree", "LP semantic tree", sdk.semanticTree],
    ["13", "sdk-structured-data", "LP structured data", sdk.structuredData],
    ["14", "sdk-links", "Links extract", sdk.links],
    ["15", "sdk-extract-wiki", "TTFX + extract (Wikipedia)", sdk.extractWiki],
    ["16", "sdk-detect-forms", "LP detectForms", sdk.detectForms],
    ["17", "sdk-interactive-elements", "LP interactive elements", sdk.interactive],
  ];

  for (const [id, slug, title, data] of sdkTests) {
    if (!data) continue;
    writeMd(`${id}-${slug}.md`, `${mdHeader(id, title, m)}
## Kết quả

- Thời gian: **${data.ms} ms**
- Trạng thái: ${data.ok ? "✅ PASS" : "❌ FAIL"}

## Đánh giá

${data.ms < 5000 ? "🟢 Latency chấp nhận được cho agent pipeline." : "🟡 Latency cao — kiểm tra network hoặc waitUntil."}
`);
    written.push(`${id}-${slug}.md`);
  }

  if (sdk.agentFill) {
    writeMd("18-sdk-agent-fill.md", `${mdHeader("18", "NodeHandle fill (backendNodeId)", m)}
## Kết quả

- Thời gian: **${sdk.agentFill.ms} ms**
- Trạng thái: ${sdk.agentFill.ok ? "✅ PASS" : "❌ FAIL"}

## Đánh giá

🟢 Fill qua LP backend-node — workflow agent chính (không cần CSS selector fragile).
`);
    written.push("18-sdk-agent-fill.md");
  }

  console.log("=== Crawl mini (1 test) ===");
  const crawl = await runMiniCrawl(options);
  writeMd("19-crawl-wikipedia-mini.md", `${mdHeader("19", `Crawl Wikipedia (${crawl.total} trang, c=2)`, m)}
## Kết quả

| Metric | Giá trị |
|--------|--------:|
| Thành công | ${crawl.success}/${crawl.total} |
| Mean TTFX | ${fmt(crawl.meanTtfexMs)} ms |
| Mean extract | ${fmt(crawl.meanExtractMs)} ms |

## Đánh giá

${crawl.success === crawl.total ? "🟢 **Production crawl path ổn định** — dùng createCrawlWorker cho scale." : "🔴 Có trang fail — kiểm tra timeout/network."}
`);
  written.push("19-crawl-wikipedia-mini.md");

  writeMd("20-summary.md", `${mdHeader("20", "Tổng hợp benchmark suite", m)}
## Tổng quan

Chạy **${written.length + 1}** báo cáo benchmark (folder \`benchmark/\` chỉ chứa .md).

### Microbench vs Chromium

| Nhóm | Geomean ratio (V/C) | Đánh giá |
|------|--------------------:|----------|
| Navigation | **${micro.navGeomean?.toFixed(2) ?? "n/a"}x** | ${verdict(micro.navGeomean).emoji} ${verdict(micro.navGeomean).label} |
| JS workloads | **${micro.jsGeomean?.toFixed(2) ?? "n/a"}x** | ${verdict(micro.jsGeomean).emoji} ${verdict(micro.jsGeomean).label} |
| Startup | **${startupRatio?.toFixed(2) ?? "n/a"}x** | ${verdict(startupRatio, false).emoji} ${verdict(startupRatio, false).label} |

### SDK / Agent

- LP extraction APIs: ${sdk.error ? `❌ ${sdk.error}` : "✅ pass"}
- Crawl mini: ${crawl.success}/${crawl.total} trang

### Khuyến nghị

1. **Scale crawl** — \`npm run example:crawl\` hoặc \`bench:crawl:wikipedia\` khi cần so sánh Chromium.
2. **Agent** — dùng \`page.detectForms\` + \`NodeHandle\` thay vì CSS thuần.
3. **Đo lại** sau mỗi thay đổi engine lớn; lưu snapshot mới vào \`benchmark/\`.

## Danh sách file

${[...written, "20-summary.md"].map((f) => `- [\`${f}\`](./${f})`).join("\n")}
`);
  written.push("20-summary.md");

  writeFileSync(TMP_JSON, JSON.stringify({ meta: m, micro, sdk, crawl, files: written }, null, 2));

  console.log(`\n=== Done: ${written.length} files in benchmark/ ===`);
  for (const f of written) console.log(`  benchmark/${f}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});