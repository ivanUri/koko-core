#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapterFactories, detectChrome } from "./adapters/index.mjs";
import { processTreeSnapshot } from "./common/process-tree.mjs";
import { describe } from "./common/statistics.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage: node bench/live-sitemap-compare.mjs --sitemap <url> [options]

Options:
  --count <n>             Maximum unique sitemap URLs (default: 1000).
  --output-dir <dir>     Report directory.
  --baselines <ids>      Comma-separated adapters (default: koko-cdp,chromium-cdp).
  --concurrency <n>      Concurrent isolated sessions (default: 4).
  --restart-every <n>   Restart each browser after N URLs (default: 0, one long-lived process).
  --wait-until <event>   domcontentloaded or load (default: domcontentloaded).
  --settle-ms <n>        Hydration delay after navigation (default: 1000).
  --timeout-ms <n>       Per CDP operation timeout (default: 45000).
  --koko-bin <path>      Koko executable.
  --chrome-bin <path>    Chrome/Chromium executable.
`;
}

function positiveInteger(value, option, { allowZero = false } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) {
    throw new Error(`${option} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const options = {
    count: 1000,
    baselines: ["koko-cdp", "chromium-cdp"],
    concurrency: 4,
    restartEvery: 0,
    waitUntil: "domcontentloaded",
    settleMs: 1000,
    timeoutMs: 45_000,
    kokoBin: path.join(projectRoot, "zig-out", "bin", "koko"),
    outputDir: path.join(projectRoot, "bench-results", `sitemap-compare-${stamp}`),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help") return { help: true };
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    switch (option) {
      case "--sitemap": options.sitemap = value; break;
      case "--count": options.count = positiveInteger(value, option); break;
      case "--output-dir": options.outputDir = path.resolve(projectRoot, value); break;
      case "--baselines": options.baselines = value.split(",").map((item) => item.trim()).filter(Boolean); break;
      case "--concurrency": options.concurrency = positiveInteger(value, option); break;
      case "--restart-every": options.restartEvery = positiveInteger(value, option, { allowZero: true }); break;
      case "--wait-until": options.waitUntil = value; break;
      case "--settle-ms": options.settleMs = positiveInteger(value, option, { allowZero: true }); break;
      case "--timeout-ms": options.timeoutMs = positiveInteger(value, option); break;
      case "--koko-bin": options.kokoBin = path.resolve(projectRoot, value); break;
      case "--chrome-bin": options.chromeBin = path.resolve(projectRoot, value); break;
      default: throw new Error(`Unknown option: ${option}`);
    }
  }
  if (!options.sitemap) throw new Error("--sitemap is required");
  if (!["domcontentloaded", "load"].includes(options.waitUntil)) {
    throw new Error("--wait-until must be domcontentloaded or load");
  }
  return options;
}

async function loadSitemap(sitemap, count) {
  const response = await fetch(sitemap, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Sitemap returned HTTP ${response.status}`);
  const xml = await response.text();
  const urls = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
    .map((match) => match[1].replaceAll("&amp;", "&").trim())
    .filter((url, index, all) => all.indexOf(url) === index)
    .filter((url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" || parsed.protocol === "http:";
      } catch {
        return false;
      }
    });
  if (urls.length === 0) throw new Error("Sitemap contained no valid URLs");
  return { urls: urls.slice(0, count), discovered: urls.length };
}

function pageStateExpression() {
  return `(() => {
    const root = document.documentElement;
    const bodyText = document.body?.innerText ?? "";
    return {
      finalUrl: location.href,
      title: document.title,
      htmlChars: root?.outerHTML?.length ?? 0,
      textChars: document.body?.textContent?.length ?? 0,
      visibleTextChars: bodyText.length,
      elementCount: document.getElementsByTagName("*").length,
      imageCount: document.images.length,
      linkCount: document.links.length,
      challengeVisible: /captcha|security verification|verify you are human|access denied/i.test(bodyText),
    };
  })()`;
}

function startSampler(pid) {
  const snapshots = [];
  const take = () => {
    try {
      snapshots.push(processTreeSnapshot(pid));
    } catch {
      // Runtime shutdown can race the final sample.
    }
  };
  take();
  const timer = setInterval(take, 250);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      take();
      return snapshots;
    },
  };
}

function startSetSampler(activePids) {
  const snapshots = [];
  const take = () => {
    let rssBytes = 0;
    let cpuPercent = 0;
    let processCount = 0;
    for (const pid of activePids.values()) {
      try {
        const snapshot = processTreeSnapshot(pid);
        rssBytes += snapshot.rssBytes;
        cpuPercent += snapshot.cpuPercent;
        processCount += snapshot.processCount;
      } catch {
        // A page process may exit between the PID lookup and ps sampling.
      }
    }
    snapshots.push({ rssBytes, cpuPercent, processCount });
  };
  take();
  const timer = setInterval(take, 250);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      take();
      return snapshots;
    },
  };
}

async function navigateOne({ runtime, url, index, options }) {
  const started = performance.now();
  let session;
  try {
    session = await runtime.newSession();
    const navigation = await session.navigate(url, {
      waitUntil: options.waitUntil,
      timeoutMs: options.timeoutMs,
    });
    if (options.settleMs > 0) await new Promise((resolve) => setTimeout(resolve, options.settleMs));
    const state = await session.evaluate(pageStateExpression(), options.timeoutMs);
    if (!state || state.htmlChars < 100 || state.elementCount < 2) {
      throw new Error(`Document validation failed: ${JSON.stringify(state)}`);
    }
    if (Number.isFinite(navigation.httpStatus) && navigation.httpStatus >= 400) {
      throw new Error(`Main document returned HTTP ${navigation.httpStatus}`);
    }
    return {
      index,
      url,
      success: true,
      elapsedMs: performance.now() - started,
      navigationMs: navigation.durationMs,
      navigationAckMs: navigation.navigationAckMs,
      httpStatus: navigation.httpStatus,
      responseCountAtReady: navigation.responseCount,
      ...state,
    };
  } catch (error) {
    return {
      index,
      url,
      success: false,
      elapsedMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await session?.close().catch(() => {});
  }
}

async function runConcurrent(runtime, urls, options) {
  let nextIndex = 0;
  let completed = 0;
  const results = new Array(urls.length);
  const workers = Array.from({ length: Math.min(options.concurrency, urls.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= urls.length) return;
      results[index] = await navigateOne({ runtime, url: urls[index], index, options });
      completed += 1;
      if (completed === urls.length || completed % 25 === 0) {
        process.stdout.write(`\r  ${completed}/${urls.length} pages`);
      }
    }
  });
  await Promise.all(workers);
  process.stdout.write("\n");
  return results;
}

function summarize(baseline, launchMs, wallMs, results, snapshots) {
  const successes = results.filter((result) => result.success);
  const peakRssBytes = snapshots.length ? Math.max(...snapshots.map((snapshot) => snapshot.rssBytes)) : null;
  const averageCpuPercent = snapshots.length
    ? snapshots.reduce((sum, snapshot) => sum + snapshot.cpuPercent, 0) / snapshots.length
    : null;
  const finite = (name) => describe(successes.map((result) => result[name]));
  return {
    baseline,
    launchMs,
    wallMs,
    totalWallMs: wallMs + (launchMs ?? 0),
    attempts: results.length,
    successes: successes.length,
    failures: results.length - successes.length,
    successRate: results.length ? successes.length / results.length : 0,
    throughputPagesPerSecond: wallMs > 0 ? successes.length / (wallMs / 1000) : 0,
    effectiveThroughputPagesPerSecond: wallMs + (launchMs ?? 0) > 0
      ? successes.length / ((wallMs + (launchMs ?? 0)) / 1000)
      : 0,
    elapsedMs: finite("elapsedMs"),
    navigationMs: finite("navigationMs"),
    navigationAckMs: finite("navigationAckMs"),
    htmlChars: finite("htmlChars"),
    textChars: finite("textChars"),
    visibleTextChars: finite("visibleTextChars"),
    elementCount: finite("elementCount"),
    imageCount: finite("imageCount"),
    peakRssBytes,
    averageCpuPercent,
    maxProcessCount: snapshots.length ? Math.max(...snapshots.map((snapshot) => snapshot.processCount)) : null,
    httpErrors: successes.filter((result) => Number.isFinite(result.httpStatus) && result.httpStatus >= 400).length,
    visibleChallenges: successes.filter((result) => result.challengeVisible || /\/risk\/|captcha/i.test(result.finalUrl ?? "")).length,
  };
}

function number(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}

function mib(bytes) {
  return Number.isFinite(bytes) ? number(bytes / 1024 / 1024) : "n/a";
}

function markdown(report) {
  const rows = report.runs.map(({ summary }) =>
    `| ${summary.baseline} | ${summary.successes}/${summary.attempts} | ${number(summary.totalWallMs / 1000)} | ${number(summary.effectiveThroughputPagesPerSecond)} | ${number(summary.elapsedMs?.p50)} / ${number(summary.elapsedMs?.p95)} | ${number(summary.navigationMs?.p50)} / ${number(summary.navigationMs?.p95)} | ${mib(summary.peakRssBytes)} | ${number(summary.averageCpuPercent)} | ${summary.maxProcessCount ?? "n/a"} | ${summary.visibleChallenges} |`).join("\n");
  const contentRows = report.runs.map(({ summary }) =>
    `| ${summary.baseline} | ${number(summary.htmlChars?.p50)} | ${number(summary.elementCount?.p50)} | ${number(summary.imageCount?.p50)} | ${number(summary.textChars?.p50)} |`).join("\n");
  const failures = report.runs.flatMap(({ baseline, results }) => results
    .filter((result) => !result.success)
    .slice(0, 30)
    .map((result) => `- ${baseline} — ${result.url}: ${result.error}`));
  return `# Sitemap crawl benchmark\n\n` +
    `Run: \`${report.startedAt}\`  \n` +
    `Sitemap: ${report.options.sitemap}  \n` +
    `Discovered: ${report.discoveredUrls}; measured: ${report.urls.length}; concurrency: ${report.options.concurrency}; restart-every: ${report.options.restartEvery || "none"}; wait: ${report.options.waitUntil}; settle: ${report.options.settleMs} ms\n\n` +
    `| Baseline | Success | Wall s | pages/s | End-to-end p50 / p95 ms | Navigation p50 / p95 ms | Peak RSS MiB | Avg CPU % | Max processes | Challenges |\n` +
    `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\n` +
    `## Content signals\n\n` +
    `| Baseline | HTML p50 chars | Elements p50 | Images p50 | Text p50 chars |\n` +
    `|---|---:|---:|---:|---:|\n${contentRows}\n\n` +
    `This measures navigation and DOM metrics, not HTML export or disk throughput. Each adapter runs one browser process with isolated CDP sessions; cache is disabled by the CDP session. The sitemap is live external traffic and may change or apply rate limits.\n` +
    (failures.length ? `\n## First failures\n\n${failures.join("\n")}\n` : "");
}

async function runFactory(factory, urls, options) {
  const batchSize = options.restartEvery > 0 ? options.restartEvery : urls.length;
  const results = [];
  const snapshots = [];
  const runtimeOutputs = [];
  let launchMs = 0;
  let wallMs = 0;

  for (let start = 0; start < urls.length; start += batchSize) {
    const batchUrls = urls.slice(start, start + batchSize);
    const runtime = factory.create();
    let sampler;
    const batchStarted = performance.now();
    try {
      process.stdout.write(`\n${factory.id}: batch ${start + 1}-${start + batchUrls.length}/${urls.length}\n`);
      await runtime.launch();
      launchMs += runtime.launchMetrics?.processReadyMs ?? 0;
      sampler = startSampler(runtime.pid);
      const batchResults = await runConcurrent(runtime, batchUrls, options);
      const batchSnapshots = sampler.stop();
      sampler = null;
      snapshots.push(...batchSnapshots);
      results.push(...batchResults.map((result) => ({ ...result, index: result.index + start })));
      runtimeOutputs.push({ start, stdout: runtime.output?.stdout ?? "", stderr: runtime.output?.stderr ?? "" });
    } catch (error) {
      const batchSnapshots = sampler?.stop() ?? [];
      sampler = null;
      snapshots.push(...batchSnapshots);
      results.push(...batchUrls.map((url, index) => ({
        index: start + index,
        url,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })));
      runtimeOutputs.push({
        start,
        stdout: runtime.output?.stdout ?? "",
        stderr: `${runtime.output?.stderr ?? ""}\n${error instanceof Error ? error.stack ?? error.message : String(error)}`,
      });
    } finally {
      sampler?.stop();
      await runtime.close().catch(() => {});
      wallMs += performance.now() - batchStarted - (runtime.launchMetrics?.processReadyMs ?? 0);
    }
  }

  return {
    summary: summarize(factory.id, launchMs, wallMs, results, snapshots),
    runtimeOutputs,
    results: results.sort((left, right) => left.index - right.index),
  };
}

async function runFactoryPerPage(factory, urls, options) {
  const activePids = new Map();
  const sampler = startSetSampler(activePids);
  const results = [];
  const runtimeOutputs = [];
  let nextIndex = 0;
  let completed = 0;
  let launchMs = 0;
  const started = performance.now();
  const workers = Array.from({ length: Math.min(options.concurrency, urls.length) }, async (_, worker) => {
    while (true) {
      const index = nextIndex++;
      if (index >= urls.length) return;
      const runtime = factory.create();
      const pageStarted = performance.now();
      let pageLaunchMs = 0;
      let result;
      try {
        const launchStarted = performance.now();
        await runtime.launch();
        pageLaunchMs = performance.now() - launchStarted;
        activePids.set(`${worker}:${index}`, runtime.pid);
        result = await navigateOne({ runtime, url: urls[index], index, options });
        result.elapsedMs += pageLaunchMs;
      } catch (error) {
        result = {
          index,
          url: urls[index],
          success: false,
          elapsedMs: performance.now() - pageStarted,
          error: error instanceof Error ? error.message : String(error),
        };
      } finally {
        activePids.delete(`${worker}:${index}`);
        runtimeOutputs.push({ index, stdout: runtime.output?.stdout ?? "", stderr: runtime.output?.stderr ?? "" });
        await runtime.close().catch(() => {});
      }
      launchMs += pageLaunchMs;
      results.push(result);
      completed += 1;
      if (completed === urls.length || completed % 25 === 0) {
        process.stdout.write(`\r  ${completed}/${urls.length} pages`);
      }
    }
  });
  await Promise.all(workers);
  const totalWallMs = performance.now() - started;
  const snapshots = sampler.stop();
  return {
    summary: summarize(factory.id, launchMs, Math.max(0, totalWallMs - launchMs), results, snapshots),
    runtimeOutputs,
    results: results.sort((left, right) => left.index - right.index),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!existsSync(options.kokoBin)) throw new Error(`Koko binary not found: ${options.kokoBin}`);
  options.chromeBin = detectChrome(options.chromeBin);
  const sitemapResult = await loadSitemap(options.sitemap, options.count);
  await mkdir(options.outputDir, { recursive: true });
  const factories = createAdapterFactories(options.baselines, {
    projectRoot,
    kokoBin: options.kokoBin,
    chromeBin: options.chromeBin,
    timeoutMs: options.timeoutMs,
  });
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    host: { platform: `${process.platform} ${process.arch}`, cpus: os.cpus().length, totalMemoryBytes: os.totalmem() },
    discoveredUrls: sitemapResult.discovered,
    options: { ...options, outputDir: path.resolve(options.outputDir) },
    urls: sitemapResult.urls,
    runs: [],
  };

  process.stdout.write(`Sitemap contains ${sitemapResult.discovered} unique URLs; measuring ${sitemapResult.urls.length}.\n`);
  for (const factory of factories) {
    const run = options.restartEvery === 1
      ? await runFactoryPerPage(factory, sitemapResult.urls, options)
      : await runFactory(factory, sitemapResult.urls, options);
    report.runs.push({ baseline: factory.id, ...run });
  }

  await writeFile(path.join(options.outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const reportMarkdown = markdown(report);
  await writeFile(path.join(options.outputDir, "report.md"), reportMarkdown);
  await new Promise((resolve) => process.stdout.write(`\n${reportMarkdown}\nSaved to ${options.outputDir}\n`, resolve));
  process.exit(report.runs.some(({ summary }) => summary.failures > 0) ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`FAIL: ${error.message}\n`);
  process.exitCode = 1;
});
