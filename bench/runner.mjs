#!/usr/bin/env node
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapterFactories, allAdapterIds, detectChrome } from "./adapters/index.mjs";
import { collectEnvironment } from "./common/environment.mjs";
import { startFixtureServer } from "./common/fixture-server.mjs";
import { RunContext } from "./common/run-context.mjs";
import { summarizeRecords } from "./common/statistics.mjs";
import { renderMarkdownReport } from "./reports/markdown.mjs";
import { runIdleMemorySuite } from "./suites/idle-memory.mjs";
import { runConcurrencySuite } from "./suites/concurrency.mjs";
import { runLongRunSuite } from "./suites/long-run.mjs";
import { runNetworkSuite } from "./suites/network.mjs";
import { runDomJsSuite } from "./suites/dom-js.mjs";
import { runAgentSuite } from "./suites/agent.mjs";
import { runNavigationSuite } from "./suites/navigation.mjs";
import { runRealSitesSuite } from "./suites/real-sites.mjs";
import { runSessionLifecycleSuite } from "./suites/session-lifecycle.mjs";
import { runStartupSuite } from "./suites/startup.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deterministicSuites = ["startup", "navigation", "session-lifecycle", "idle-memory"];
const allSuites = [...deterministicSuites, "concurrency", "network", "dom-js", "agent", "long-run"];
const suiteRunners = new Map([
  ["startup", runStartupSuite],
  ["navigation", runNavigationSuite],
  ["session-lifecycle", runSessionLifecycleSuite],
  ["idle-memory", runIdleMemorySuite],
  ["concurrency", runConcurrencySuite],
  ["network", runNetworkSuite],
  ["dom-js", runDomJsSuite],
  ["agent", runAgentSuite],
  ["long-run", runLongRunSuite],
  ["real-sites", runRealSitesSuite],
]);

function values(value) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function positiveInteger(value, name, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return parsed;
}

function parseArgs(argv) {
  const options = {
    suites: [...deterministicSuites],
    baselines: ["koko-cdp", "chromium-cdp"],
    warmup: 5,
    iterations: 30,
    memoryWarmup: 1,
    memoryIterations: 5,
    densities: [1, 4, 8, 16],
    activeSessions: 0,
    concurrencyWarmup: 1,
    concurrencyIterations: 5,
    longRunWarmup: 5,
    longRunIterations: 100,
    httpMaxConcurrent: null,
    httpMaxHostOpen: null,
    cdpMaxConnections: 64,
    timeoutMs: 30_000,
    idleSettleMs: 250,
    memorySampling: { samples: 5, intervalMs: 100 },
    realSiteFile: "bench/real-sites.json",
    realSiteWarmup: 1,
    realSiteIterations: 3,
    realSiteSettleMs: 1_000,
    realSiteTimeoutMs: 45_000,
    output: "bench-results",
    kokoBin: "zig-out/bin/koko",
    chromeBin: null,
    optimize: "unknown",
    allowNonRelease: false,
    allowFailures: false,
    regressionAgainst: null,
    regressionThresholdPct: 10,
    regressionMode: "warn",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value after ${argument}`);
      return value;
    };
    if (argument === "--suite") options.suites = values(next());
    else if (argument === "--baseline") {
      const selected = values(next());
      options.baselines = selected.includes("all") ? [...allAdapterIds] : selected;
    } else if (argument === "--warmup") options.warmup = positiveInteger(next(), argument);
    else if (argument === "--iterations") options.iterations = positiveInteger(next(), argument, 1);
    else if (argument === "--memory-warmup") options.memoryWarmup = positiveInteger(next(), argument);
    else if (argument === "--memory-iterations") options.memoryIterations = positiveInteger(next(), argument, 1);
    else if (argument === "--concurrency-warmup") options.concurrencyWarmup = positiveInteger(next(), argument);
    else if (argument === "--concurrency-iterations") options.concurrencyIterations = positiveInteger(next(), argument, 1);
    else if (argument === "--long-run-warmup") options.longRunWarmup = positiveInteger(next(), argument);
    else if (argument === "--long-run-iterations") options.longRunIterations = positiveInteger(next(), argument, 1);
    else if (argument === "--http-max-concurrent") options.httpMaxConcurrent = positiveInteger(next(), argument, 1);
    else if (argument === "--http-max-host-open") options.httpMaxHostOpen = positiveInteger(next(), argument, 1);
    else if (argument === "--cdp-max-connections") options.cdpMaxConnections = positiveInteger(next(), argument, 1);
    else if (argument === "--real-warmup") options.realSiteWarmup = positiveInteger(next(), argument);
    else if (argument === "--real-iterations") options.realSiteIterations = positiveInteger(next(), argument, 1);
    else if (argument === "--real-settle-ms") options.realSiteSettleMs = positiveInteger(next(), argument);
    else if (argument === "--real-timeout-ms") options.realSiteTimeoutMs = positiveInteger(next(), argument, 1);
    else if (argument === "--site-file") options.realSiteFile = next();
    else if (argument === "--density") options.densities = values(next()).map((value) => positiveInteger(value, argument, 1));
    else if (argument === "--active-sessions") options.activeSessions = positiveInteger(next(), argument);
    else if (argument === "--timeout-ms") options.timeoutMs = positiveInteger(next(), argument, 1);
    else if (argument === "--idle-settle-ms") options.idleSettleMs = positiveInteger(next(), argument);
    else if (argument === "--output") options.output = next();
    else if (argument === "--koko-bin") options.kokoBin = next();
    else if (argument === "--chrome-bin") options.chromeBin = next();
    else if (argument === "--optimize") options.optimize = next();
    else if (argument === "--allow-non-release") options.allowNonRelease = true;
    else if (argument === "--allow-failures") options.allowFailures = true;
    else if (argument === "--regression-against") options.regressionAgainst = next();
    else if (argument === "--regression-threshold-pct") options.regressionThresholdPct = Number(next());
    else if (argument === "--regression-mode") options.regressionMode = next();
    else if (argument === "--quick") {
      options.warmup = 0;
      options.iterations = 1;
      options.memoryWarmup = 0;
      options.memoryIterations = 1;
      options.concurrencyWarmup = 0;
      options.concurrencyIterations = 1;
      options.longRunWarmup = 1;
      options.longRunIterations = 3;
      options.realSiteWarmup = 0;
      options.realSiteIterations = 1;
      options.densities = [1, 2];
      options.idleSettleMs = 50;
      options.memorySampling = { samples: 2, intervalMs: 25 };
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function printHelp() {
  process.stdout.write(`Koko Browser Runtime Benchmark\n\n` +
    `  node bench/runner.mjs [options]\n\n` +
    `Options:\n` +
    `  --suite <all|startup,navigation,session-lifecycle,idle-memory,concurrency,network,dom-js,agent,long-run,real-sites>\n` +
    `  --baseline <koko-cdp,chromium-cdp,playwright-chromium|all>\n` +
    `  --warmup <n> --iterations <n>\n` +
    `  --memory-warmup <n> --memory-iterations <n> --density <1,10,50,100,250,500,1000>\n` +
    `  --active-sessions <n> (idle-memory: navigate this many sessions)\n` +
    `  --concurrency-warmup <n> --concurrency-iterations <n>\n` +
    `  --long-run-warmup <n> --long-run-iterations <n>\n` +
    `  --http-max-concurrent <n> --http-max-host-open <n> (Koko)\n` +
    `  --cdp-max-connections <n> (Koko)\n` +
    `  --site-file <json> --real-warmup <n> --real-iterations <n> --real-settle-ms <ms>\n` +
    `  --real-timeout-ms <ms>\n` +
    `  --koko-bin <path> --chrome-bin <path> --output <directory>\n` +
    `  --timeout-ms <ms> --idle-settle-ms <ms>\n` +
    `  --regression-against <summary.json> --regression-threshold-pct <n> --regression-mode <warn|fail>\n` +
    `  --quick --allow-non-release --allow-failures\n`);
}

function validateOptions(options) {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22+ is required");
  const unknownSuites = options.suites.filter((suite) => suite !== "all" && !suiteRunners.has(suite));
  if (unknownSuites.length) throw new Error(`Unknown suites: ${unknownSuites.join(", ")}`);
  if (options.suites.includes("all")) options.suites = [...allSuites];
  const unknownBaselines = options.baselines.filter((baseline) => !allAdapterIds.includes(baseline));
  if (unknownBaselines.length) throw new Error(`Unknown baselines: ${unknownBaselines.join(", ")}`);
  if (!options.allowNonRelease && options.optimize !== "ReleaseFast") {
    throw new Error(`Refusing comparative benchmark with optimize=${options.optimize}; use zig build benchmark -Doptimize=ReleaseFast`);
  }
  options.kokoBin = resolve(projectRoot, options.kokoBin);
  if (options.baselines.includes("koko-cdp") && !existsSync(options.kokoBin)) {
    throw new Error(`Koko binary not found: ${options.kokoBin}`);
  }
  if (options.baselines.some((baseline) => baseline !== "koko-cdp")) {
    options.chromeBin = detectChrome(options.chromeBin);
  }
  options.output = resolve(projectRoot, options.output);
  options.realSiteFile = resolve(projectRoot, options.realSiteFile);
  if (options.regressionAgainst) options.regressionAgainst = resolve(projectRoot, options.regressionAgainst);
  if (!Number.isFinite(options.regressionThresholdPct) || options.regressionThresholdPct < 0) {
    throw new Error("--regression-threshold-pct must be a number >= 0");
  }
  if (!["warn", "fail"].includes(options.regressionMode)) throw new Error("--regression-mode must be warn or fail");
}

async function loadRealSites(options) {
  if (!options.suites.includes("real-sites")) return [];
  const parsed = JSON.parse(await readFile(options.realSiteFile, "utf8"));
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("Real-site file must contain a non-empty JSON array");
  const ids = new Set();
  return parsed.map((site, index) => {
    if (!site || typeof site.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(site.id)) {
      throw new Error(`Invalid site id at index ${index}`);
    }
    if (ids.has(site.id)) throw new Error(`Duplicate site id: ${site.id}`);
    ids.add(site.id);
    const url = new URL(site.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Site URL must be HTTP(S): ${site.url}`);
    return { id: site.id, url: url.href, category: String(site.category ?? "unspecified") };
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  validateOptions(options);
  const realSites = await loadRealSites(options);
  const runId = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const rawPath = resolve(options.output, "raw", `${runId}.jsonl`);
  await mkdir(options.output, { recursive: true });
  const needsFixtures = options.suites.some((suite) => ["startup", "navigation", "concurrency", "network", "dom-js", "agent", "long-run"].includes(suite)) || (options.activeSessions > 0 && options.suites.includes("idle-memory"));
  const fixtureServer = needsFixtures ? await startFixtureServer() : null;
  const context = new RunContext({
    runId,
    rawPath,
    options,
    fixtures: fixtureServer?.urls ?? {},
    fixtureOrigin: fixtureServer?.origin ?? null,
    realSites,
  });
  await context.initialize();
  const adapterOptions = {
    projectRoot,
    kokoBin: options.kokoBin,
    chromeBin: options.chromeBin,
    timeoutMs: options.timeoutMs,
    httpMaxConcurrent: options.httpMaxConcurrent,
    httpMaxHostOpen: options.httpMaxHostOpen,
    cdpMaxConnections: options.cdpMaxConnections,
  };
  const factories = createAdapterFactories(options.baselines, adapterOptions);
  const environment = await collectEnvironment({
    projectRoot,
    kokoBin: options.kokoBin,
    chromeBin: options.chromeBin,
    optimize: options.optimize,
    options: {
      suites: options.suites,
      baselines: options.baselines,
      warmup: options.warmup,
      iterations: options.iterations,
      memoryWarmup: options.memoryWarmup,
      memoryIterations: options.memoryIterations,
      densities: options.densities,
      activeSessions: options.activeSessions,
      concurrencyWarmup: options.concurrencyWarmup,
      concurrencyIterations: options.concurrencyIterations,
      longRunWarmup: options.longRunWarmup,
      longRunIterations: options.longRunIterations,
      httpMaxConcurrent: options.httpMaxConcurrent,
      httpMaxHostOpen: options.httpMaxHostOpen,
      cdpMaxConnections: options.cdpMaxConnections,
      regressionAgainst: options.regressionAgainst,
      regressionThresholdPct: options.regressionThresholdPct,
      regressionMode: options.regressionMode,
      timeoutMs: options.timeoutMs,
      idleSettleMs: options.idleSettleMs,
      memorySampling: options.memorySampling,
      realSiteFile: options.realSiteFile,
      realSiteWarmup: options.realSiteWarmup,
      realSiteIterations: options.realSiteIterations,
      realSiteTimeoutMs: options.realSiteTimeoutMs,
      realSites,
    },
  });

  process.stdout.write(`Koko benchmark ${runId}\nRaw: ${rawPath}\n`);
  try {
    for (const suite of options.suites) {
      await suiteRunners.get(suite)(context, factories);
    }
  } finally {
    await fixtureServer?.close();
  }

  const groups = summarizeRecords(context.records);
  const regression = options.regressionAgainst
    ? await evaluateRegression(options, groups)
    : null;
  const summary = { schemaVersion: 1, runId, groups, ...(regression ? { regression } : {}) };
  const summaryPath = resolve(options.output, "summary", `${runId}.json`);
  const reportPath = resolve(options.output, "report.md");
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(resolve(options.output, "environment.json"), `${JSON.stringify(environment, null, 2)}\n`);
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(reportPath, renderMarkdownReport({ runId, environment, summary }));
  process.stdout.write(`\nReport: ${reportPath}\nSummary: ${summaryPath}\n`);

  if (regression?.violations?.length) {
    const message = `${regression.violations.length} deterministic regression(s) exceeded ${options.regressionThresholdPct}%`;
    if (options.regressionMode === "fail") throw new Error(message);
    process.stderr.write(`benchmark: warning: ${message}\n`);
  }

  const failures = context.records.filter((record) => !record.warmup && !record.success).length;
  if (failures > 0 && !options.allowFailures) {
    throw new Error(`${failures} measured observation(s) failed; see raw JSONL`);
  }
}

async function evaluateRegression(options, currentGroups) {
  const previous = JSON.parse(await readFile(options.regressionAgainst, "utf8"));
  const previousGroups = new Map((previous.groups ?? []).map((group) => [
    `${group.suite}\u0000${group.workload}\u0000${group.baseline}`, group,
  ]));
  const threshold = options.regressionThresholdPct / 100;
  const violations = [];
  for (const current of currentGroups) {
    if (current.suite === "real-sites") continue;
    const previousGroup = previousGroups.get(`${current.suite}\u0000${current.workload}\u0000${current.baseline}`);
    if (!previousGroup) continue;
    const checks = [
      ["durationMs.p95", current.metrics?.durationMs?.p95, previousGroup.metrics?.durationMs?.p95, "higher-is-worse"],
      ["rssBytes.median", current.metrics?.rssBytes?.median, previousGroup.metrics?.rssBytes?.median, "higher-is-worse"],
      ["throughputPagesPerSecond.median", current.metrics?.throughputPagesPerSecond?.median, previousGroup.metrics?.throughputPagesPerSecond?.median, "lower-is-worse"],
    ];
    for (const [metricName, value, baseline, direction] of checks) {
      if (!Number.isFinite(value) || !Number.isFinite(baseline) || baseline === 0) continue;
      const change = (value - baseline) / Math.abs(baseline);
      const regressed = direction === "higher-is-worse" ? change > threshold : change < -threshold;
      if (regressed) violations.push({ suite: current.suite, workload: current.workload, baseline: current.baseline, metric: metricName, current: value, previous: baseline, changePct: change * 100 });
    }
  }
  return { against: options.regressionAgainst, thresholdPct: options.regressionThresholdPct, mode: options.regressionMode, violations };
}

main().catch((error) => {
  process.stderr.write(`benchmark: ${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
