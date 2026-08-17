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
  return `Usage: node bench/live-crawl-export.mjs --urls <file> [options]

Options:
  --output-dir <dir>       Report and HTML export directory.
  --baselines <ids>       Comma-separated adapters (default: koko-cdp,chromium-cdp).
  --concurrency <n>       Concurrent isolated sessions (default: 4).
  --wait-until <event>    domcontentloaded or load (default: domcontentloaded).
  --settle-ms <n>         Extra hydration time after navigation (default: 3000).
  --timeout-ms <n>        Per CDP operation timeout (default: 45000).
  --koko-bin <path>       Koko executable.
  --chrome-bin <path>     Chrome/Chromium executable.
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
    baselines: ["koko-cdp", "chromium-cdp"],
    concurrency: 4,
    waitUntil: "domcontentloaded",
    settleMs: 3000,
    timeoutMs: 45_000,
    kokoBin: path.join(projectRoot, "zig-out", "bin", "koko"),
    outputDir: path.join(projectRoot, "bench-results", `live-crawl-${stamp}`),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help") return { help: true };
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    switch (option) {
      case "--urls": options.urlsFile = path.resolve(projectRoot, value); break;
      case "--output-dir": options.outputDir = path.resolve(projectRoot, value); break;
      case "--baselines": options.baselines = value.split(",").map((item) => item.trim()).filter(Boolean); break;
      case "--concurrency": options.concurrency = positiveInteger(value, option); break;
      case "--wait-until": options.waitUntil = value; break;
      case "--settle-ms": options.settleMs = positiveInteger(value, option, { allowZero: true }); break;
      case "--timeout-ms": options.timeoutMs = positiveInteger(value, option); break;
      case "--koko-bin": options.kokoBin = path.resolve(projectRoot, value); break;
      case "--chrome-bin": options.chromeBin = path.resolve(projectRoot, value); break;
      default: throw new Error(`Unknown option: ${option}`);
    }
  }
  if (!options.urlsFile) throw new Error("--urls is required");
  if (!["domcontentloaded", "load"].includes(options.waitUntil)) {
    throw new Error("--wait-until must be domcontentloaded or load");
  }
  return options;
}

async function loadUrls(file) {
  const lines = (await readFile(file, "utf8"))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  for (const value of lines) {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Not an HTTP URL: ${value}`);
  }
  if (lines.length === 0) throw new Error(`No URLs in ${file}`);
  return lines;
}

function pageStateExpression() {
  return `(() => {
    const html = document.documentElement?.outerHTML ?? "";
    return {
      finalUrl: location.href,
      title: document.title,
      html,
      textChars: document.body?.textContent?.length ?? 0,
      visibleText: (document.body?.innerText ?? "").slice(0, 4000),
      elementCount: document.getElementsByTagName("*").length,
      imageCount: document.images.length,
      linkCount: document.links.length,
    };
  })()`;
}

function identityFor(url) {
  const pathname = new URL(url).pathname;
  const match = pathname.match(/-(?:p|c)-(\d+)\.html$/i);
  return match?.[1] ?? null;
}

function exportName(index, url) {
  const pathname = decodeURIComponent(new URL(url).pathname);
  const leaf = pathname.split("/").filter(Boolean).at(-1) ?? "home";
  const slug = leaf.replace(/\.html$/i, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 72) || "home";
  return `${String(index + 1).padStart(3, "0")}-${slug}.html`;
}

function startSampler(pid) {
  const snapshots = [];
  const take = () => {
    try {
      snapshots.push(processTreeSnapshot(pid));
    } catch {
      // A final sample may race runtime shutdown.
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

async function crawlOne({ runtime, url, index, exportDirectory, options }) {
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
    if (!state || state.html.length < 100 || state.elementCount < 2) {
      throw new Error(`Document validation failed: ${JSON.stringify(state)}`);
    }
    if (Number.isFinite(navigation.httpStatus) && navigation.httpStatus >= 400) {
      throw new Error(`Main document returned HTTP ${navigation.httpStatus}`);
    }
    const file = path.join(exportDirectory, exportName(index, url));
    await writeFile(file, `${state.html}\n`);
    const identity = identityFor(url);
    const challengePattern = /access denied|security verification|unusual activity|verify (?:that )?you are human|captcha/i;
    return {
      index,
      url,
      success: true,
      elapsedMs: performance.now() - started,
      navigationMs: navigation.durationMs,
      navigationAckMs: navigation.navigationAckMs,
      httpStatus: navigation.httpStatus,
      responseCountAtReady: navigation.responseCount,
      finalUrl: state.finalUrl,
      title: state.title,
      htmlChars: state.html.length,
      textChars: state.textChars,
      elementCount: state.elementCount,
      imageCount: state.imageCount,
      linkCount: state.linkCount,
      exportBytes: Buffer.byteLength(state.html),
      exportFile: path.relative(options.outputDir, file),
      expectedIdentity: identity,
      identityPresent: identity === null ? null : state.html.includes(identity),
      challengeVisible: challengePattern.test(state.visibleText),
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

async function crawlConcurrent(runtime, urls, exportDirectory, options) {
  let nextIndex = 0;
  let completed = 0;
  const results = new Array(urls.length);
  const workers = Array.from({ length: Math.min(options.concurrency, urls.length) }, async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= urls.length) return;
      results[index] = await crawlOne({ runtime, url: urls[index], index, exportDirectory, options });
      completed += 1;
      process.stdout.write(`\r  ${completed}/${urls.length} pages`);
    }
  });
  await Promise.all(workers);
  process.stdout.write("\n");
  return results;
}

function summarize(baseline, launchMs, wallMs, results, snapshots) {
  const successes = results.filter((result) => result.success);
  const identities = successes.filter((result) => result.expectedIdentity !== null);
  const peakRssBytes = snapshots.length ? Math.max(...snapshots.map((snapshot) => snapshot.rssBytes)) : null;
  const averageCpuPercent = snapshots.length
    ? snapshots.reduce((sum, snapshot) => sum + snapshot.cpuPercent, 0) / snapshots.length
    : null;
  return {
    baseline,
    launchMs,
    wallMs,
    attempts: results.length,
    successes: successes.length,
    failures: results.length - successes.length,
    throughputPagesPerSecond: successes.length / (wallMs / 1000),
    elapsedMs: describe(successes.map((result) => result.elapsedMs)),
    navigationMs: describe(successes.map((result) => result.navigationMs)),
    htmlChars: describe(successes.map((result) => result.htmlChars)),
    elementCount: describe(successes.map((result) => result.elementCount)),
    imageCount: describe(successes.map((result) => result.imageCount)),
    peakRssBytes,
    averageCpuPercent,
    maxProcessCount: snapshots.length ? Math.max(...snapshots.map((snapshot) => snapshot.processCount)) : null,
    totalExportBytes: successes.reduce((sum, result) => sum + result.exportBytes, 0),
    identityMatches: identities.filter((result) => result.identityPresent).length,
    identityChecks: identities.length,
    visibleChallenges: successes.filter((result) => result.challengeVisible).length,
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
    `| ${summary.baseline} | ${summary.successes}/${summary.attempts} | ${number(summary.wallMs / 1000)} | ${number(summary.throughputPagesPerSecond)} | ${number(summary.elapsedMs?.p50)} / ${number(summary.elapsedMs?.p95)} | ${number(summary.navigationMs?.p50)} / ${number(summary.navigationMs?.p95)} | ${mib(summary.peakRssBytes)} | ${number(summary.averageCpuPercent)} | ${mib(summary.totalExportBytes)} | ${summary.identityMatches}/${summary.identityChecks} | ${summary.visibleChallenges} |`).join("\n");
  const failures = report.runs.flatMap(({ baseline, results }) => results
    .filter((result) => !result.success)
    .map((result) => `- ${baseline} — ${result.url}: ${result.error}`));
  const contentRows = report.runs.map(({ summary }) =>
    `| ${summary.baseline} | ${number((summary.htmlChars?.p50 ?? 0) / 1024)} | ${number(summary.elementCount?.p50)} | ${number(summary.imageCount?.p50)} | ${summary.identityMatches}/${summary.identityChecks} | ${summary.visibleChallenges} |`).join("\n");
  return `# Live crawl and export benchmark\n\n` +
    `Run: \`${report.startedAt}\`  \n` +
    `URLs: ${report.urls.length} from \`${report.options.urlsFile}\`  \n` +
    `Concurrency: ${report.options.concurrency}; wait: ${report.options.waitUntil}; settle: ${report.options.settleMs} ms; timeout: ${report.options.timeoutMs} ms\n\n` +
    `| Baseline | Success | Wall s | pages/s | End-to-end p50 / p95 ms | Navigation p50 / p95 ms | Peak RSS MiB | Avg CPU % | HTML MiB | URL identity | Visible challenge |\n` +
    `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows}\n\n` +
    `## Content signals\n\n` +
    `| Baseline | HTML p50 KiB | Elements p50 | Images p50 | URL identity | Visible challenge |\n` +
    `|---|---:|---:|---:|---:|---:|\n${contentRows}\n\n` +
    `End-to-end includes isolated-session creation, navigation, the configured settle time, DOM serialization, and writing HTML. Peak RSS is the full runtime process tree sampled every 250 ms. CPU is the mean of sampled process-tree CPU percentages. URL identity checks verify that product/category IDs from the requested URL remain present in the exported DOM; they do not prove visual or behavioral parity.\n\n` +
    `This is live external traffic. CDN routing, anti-bot policy, experiments, and page deployments can change the result. Cache is disabled by the CDP session. Compare content signals as well as speed.\n` +
    (failures.length ? `\n## Failures\n\n${failures.join("\n")}\n` : "");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (!existsSync(options.kokoBin)) throw new Error(`Koko binary not found: ${options.kokoBin}`);
  options.chromeBin = detectChrome(options.chromeBin);
  const urls = await loadUrls(options.urlsFile);
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
    options: { ...options, outputDir: path.resolve(options.outputDir) },
    urls,
    runs: [],
  };

  for (const factory of factories) {
    process.stdout.write(`\n${factory.id}: launching\n`);
    const runtime = factory.create();
    let sampler;
    try {
      await runtime.launch();
      sampler = startSampler(runtime.pid);
      const exportDirectory = path.join(options.outputDir, "exports", factory.id);
      await mkdir(exportDirectory, { recursive: true });
      const started = performance.now();
      const results = await crawlConcurrent(runtime, urls, exportDirectory, options);
      const wallMs = performance.now() - started;
      const snapshots = sampler.stop();
      sampler = null;
      report.runs.push({
        baseline: factory.id,
        summary: summarize(factory.id, runtime.launchMetrics?.processReadyMs ?? null, wallMs, results, snapshots),
        results,
      });
    } catch (error) {
      const snapshots = sampler?.stop() ?? [];
      sampler = null;
      report.runs.push({
        baseline: factory.id,
        summary: summarize(factory.id, runtime.launchMetrics?.processReadyMs ?? null, 0, urls.map(() => ({ success: false })), snapshots),
        results: urls.map((url, index) => ({ index, url, success: false, error: error instanceof Error ? error.message : String(error) })),
      });
    } finally {
      sampler?.stop();
      await runtime.close().catch(() => {});
    }
  }

  await writeFile(path.join(options.outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const reportMarkdown = markdown(report);
  await writeFile(path.join(options.outputDir, "report.md"), reportMarkdown);
  await new Promise((resolve) => process.stdout.write(
    `\n${reportMarkdown}\nSaved to ${options.outputDir}\n`,
    resolve,
  ));
  process.exit(report.runs.some(({ summary }) => summary.failures > 0) ? 1 : 0);
}

main().catch((error) => {
  process.stderr.write(`FAIL: ${error.message}\n`);
  process.exitCode = 1;
});
