#!/usr/bin/env node
/*
 * Bounded Stylo performance suite.
 *
 * This is intentionally standalone: it uses the existing adapter, process
 * tree, and statistics helpers without changing the benchmark runner or the
 * browser runtime. The fixture is generated in memory so every run measures
 * the same CSS and DOM shape.
 */
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapterFactories, detectChrome } from "../adapters/index.mjs";
import { sampleProcessTree } from "../common/process-tree.mjs";
import { describe } from "../common/statistics.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workloadNames = [
  "startup",
  "css-parsing",
  "computed-style-full",
  "computed-style-incremental",
  "repeated-navigation",
  "concurrent-sessions",
];

const limits = {
  warmup: 20,
  iterations: 50,
  navigationIterations: 100,
  concurrencyWarmup: 20,
  concurrencyIterations: 50,
  density: 32,
  cssRules: 4_096,
  styleNodes: 1_000,
  styleReads: 100,
  incrementalNodes: 128,
  memorySamples: 20,
  memoryIntervalMs: 5_000,
  timeoutMs: 120_000,
};

function integer(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function values(value) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const options = {
    workloads: [...workloadNames],
    baselines: ["koko-cdp", "chromium-cdp"],
    kokoBin: "zig-out/bin/koko",
    chromeBin: null,
    warmup: 1,
    iterations: 3,
    navigationIterations: 5,
    concurrencyWarmup: 1,
    concurrencyIterations: 3,
    densities: [1, 2, 4],
    cssRules: 256,
    styleNodes: 128,
    styleReads: 3,
    incrementalNodes: 16,
    memorySamples: 3,
    memoryIntervalMs: 50,
    timeoutMs: 30_000,
    output: null,
    allowFailures: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value after ${argument}`);
      return value;
    };
    if (argument === "--workload") options.workloads = values(next());
    else if (argument === "--baseline") options.baselines = values(next());
    else if (argument === "--koko-bin") options.kokoBin = next();
    else if (argument === "--chrome-bin") options.chromeBin = next();
    else if (argument === "--warmup") options.warmup = integer(next(), argument, 0, limits.warmup);
    else if (argument === "--iterations") options.iterations = integer(next(), argument, 1, limits.iterations);
    else if (argument === "--navigation-iterations") {
      options.navigationIterations = integer(next(), argument, 1, limits.navigationIterations);
    } else if (argument === "--concurrency-warmup") {
      options.concurrencyWarmup = integer(next(), argument, 0, limits.concurrencyWarmup);
    } else if (argument === "--concurrency-iterations") {
      options.concurrencyIterations = integer(next(), argument, 1, limits.concurrencyIterations);
    } else if (argument === "--density") {
      options.densities = values(next()).map((value) => integer(value, argument, 1, limits.density));
    } else if (argument === "--css-rules") {
      options.cssRules = integer(next(), argument, 1, limits.cssRules);
    } else if (argument === "--style-nodes") {
      options.styleNodes = integer(next(), argument, 1, limits.styleNodes);
    } else if (argument === "--style-reads") {
      options.styleReads = integer(next(), argument, 1, limits.styleReads);
    } else if (argument === "--incremental-nodes") {
      options.incrementalNodes = integer(next(), argument, 1, limits.incrementalNodes);
    } else if (argument === "--memory-samples") {
      options.memorySamples = integer(next(), argument, 1, limits.memorySamples);
    } else if (argument === "--memory-interval-ms") {
      options.memoryIntervalMs = integer(next(), argument, 0, limits.memoryIntervalMs);
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = integer(next(), argument, 1, limits.timeoutMs);
    } else if (argument === "--output") options.output = next();
    else if (argument === "--allow-failures") options.allowFailures = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }

  if (options.workloads.includes("all")) options.workloads = [...workloadNames];
  const unknownWorkloads = options.workloads.filter((workload) => !workloadNames.includes(workload));
  if (unknownWorkloads.length) throw new Error(`Unknown workload(s): ${unknownWorkloads.join(", ")}`);
  if (options.workloads.length === 0) throw new Error("--workload must select at least one workload");
  if (options.baselines.length === 0) throw new Error("--baseline must select at least one adapter");
  return options;
}

function usage() {
  return [
    "Bounded Stylo performance benchmark",
    "",
    "  node bench/suites/stylo-performance.mjs [options]",
    "",
    "Workloads:",
    `  ${workloadNames.join(", ")}`,
    "",
    "Options:",
    "  --workload <all|comma-separated> --baseline <koko-cdp,chromium-cdp>",
    "  --koko-bin <path> --chrome-bin <path>",
    "  --warmup <n> --iterations <n> --navigation-iterations <n>",
    "  --concurrency-warmup <n> --concurrency-iterations <n> --density <1,2,4>",
    "  --css-rules <n> --style-nodes <n> --style-reads <n> --incremental-nodes <n>",
    "  --memory-samples <n> --memory-interval-ms <n> --timeout-ms <n>",
    "  --output <json-path> --allow-failures",
    "",
    "All iteration, DOM, CSS, density, and sampling options have hard upper bounds.",
    "",
  ].join("\n");
}

function color(index, offset) {
  return (31 + index * 17 + offset * 13) % 255;
}

function cssParsingPage(ruleCount) {
  const rules = Array.from({ length: ruleCount }, (_, index) =>
    `.stylo-parse-${index}{color:rgb(${color(index, 0)},${color(index, 1)},${color(index, 2)});margin:${index % 19}px;--stylo-parse-${index}:${index}px;}`,
  ).join("");
  const targetClass = `stylo-parse-${Math.max(0, ruleCount - 1)}`;
  return {
    body: `<!doctype html><meta charset="utf-8"><style>${rules}</style><body><div id="css-target" class="${targetClass}">parse</div>`,
    cssBytes: Buffer.byteLength(rules),
  };
}

function computedStylePage(nodeCount, incrementalNodes) {
  const nodes = Array.from({ length: nodeCount }, (_, index) =>
    `<div class="stylo-node" data-index="${index}">stylo-${index}</div>`,
  ).join("");
  const properties = [
    "color", "margin-top", "margin-right", "padding-top", "padding-right",
    "border-top-width", "border-top-style", "font-size", "line-height", "display",
  ];
  return `<!doctype html><meta charset="utf-8"><style>
    :root { --stylo-performance-color: rgb(31,41,51); --stylo-performance-gap: 4px; }
    .stylo-node { color: var(--stylo-performance-color); margin: var(--stylo-performance-gap); padding: 2px; border: 1px solid rgb(61,71,81); }
    .stylo-node.hot { color: rgb(91,101,111); padding: 3px; }
  </style><main id="stylo-performance-root">${nodes}</main><script>
    const styloNodes = [...document.querySelectorAll('.stylo-node')];
    const styloProperties = ${JSON.stringify(properties)};
    const styloIncrementalLimit = ${Math.min(nodeCount, incrementalNodes)};
    let styloEpoch = 0;
    function styloRead(node) {
      const style = getComputedStyle(node);
      let checksum = 0;
      for (const property of styloProperties) checksum += style.getPropertyValue(property).length;
      return checksum;
    }
    function styloFull() {
      let checksum = 0;
      for (const node of styloNodes) checksum += styloRead(node);
      return checksum;
    }
    function styloIncremental() {
      let checksum = 0;
      for (let index = 0; index < styloIncrementalLimit; index += 1) {
        styloNodes[index].classList.toggle('hot', (styloEpoch + index) % 2 === 0);
        checksum += styloRead(styloNodes[index]);
      }
      styloEpoch += 1;
      return checksum;
    }
    window.__styloPerformance = {
      run(kind, repetitions) {
        if (typeof getComputedStyle !== 'function') return { status: 'unsupported', reason: 'getComputedStyle unavailable' };
        const operation = kind === 'full' ? styloFull : kind === 'incremental' ? styloIncremental : null;
        if (!operation) return { status: 'unsupported', reason: 'unknown computed-style operation' };
        let checksum = 0;
        const started = performance.now();
        for (let index = 0; index < repetitions; index += 1) checksum += operation();
        return { status: 'pass', durationMs: performance.now() - started, checksum, repetitions, nodeCount: styloNodes.length, touchedNodes: kind === 'full' ? styloNodes.length : styloIncrementalLimit };
      },
    };
  </script>`;
}

function startupPage() {
  return "<!doctype html><meta charset=\"utf-8\"><body><div id=\"fixture\" data-ready=\"true\">startup</div>";
}

function startPerformanceServer(options) {
  const cssPage = cssParsingPage(options.cssRules);
  const pages = new Map([
    ["/stylo/startup.html", startupPage()],
    ["/stylo/css-parse.html", cssPage.body],
    ["/stylo/computed-style.html", computedStylePage(options.styleNodes, options.incrementalNodes)],
    ["/stylo/navigation.html", computedStylePage(options.styleNodes, options.incrementalNodes)],
  ]);
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    const body = pages.get(pathname);
    if (!body) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  });
  return new Promise((resolveServer, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolveServer({
        origin: `http://127.0.0.1:${port}`,
        metadata: {
          cssBytes: cssPage.cssBytes,
          documentBytes: Buffer.byteLength(pages.get("/stylo/css-parse.html")),
          cssRuleCount: options.cssRules,
          styleNodeCount: options.styleNodes,
          incrementalNodeCount: Math.min(options.styleNodes, options.incrementalNodes),
        },
        close: () => new Promise((resolveClose, rejectClose) => {
          server.close((error) => error ? rejectClose(error) : resolveClose());
        }),
      });
    });
  });
}

function errorInfo(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
  };
}

function addRecord(records, { baseline, workload, iteration, warmup, startedAt, metrics = {}, details = null, error = null }) {
  const record = {
    baseline,
    workload,
    iteration,
    warmup,
    startedAt,
    success: !error,
    metrics,
    ...(details ? { details } : {}),
    ...(error ? { error: errorInfo(error) } : {}),
  };
  records.push(record);
  process.stdout.write(`  ${baseline}/${workload} #${iteration}${warmup ? " warmup" : ""}: ${error ? `FAIL ${record.error.message}` : "ok"}\n`);
  return record;
}

async function styleEngineProvenance(session) {
  try {
    return await session.evaluate("window.__kokoStyleEngine ?? null");
  } catch (error) {
    return { error: errorInfo(error) };
  }
}

function requireStyloForKoko(factory, provenance) {
  if (factory.id !== "koko-cdp") return;
  if (provenance?.backend !== "stylo" || provenance?.computedStyles !== true) {
    throw new Error(`Koko Stylo provenance unavailable: ${JSON.stringify(provenance)}`);
  }
}

function memoryOptions(options) {
  return { samples: options.memorySamples, intervalMs: options.memoryIntervalMs };
}

function orderedFactories(factories, iteration) {
  return iteration % 2 === 0 ? factories : [...factories].reverse();
}

async function closeSessionAndRuntime(session, runtime) {
  await session?.close().catch(() => {});
  await runtime?.close().catch(() => {});
}

async function runStartup(server, factories, options, records) {
  const total = options.warmup + options.iterations;
  for (let index = 0; index < total; index += 1) {
    const warmup = index < options.warmup;
    const iteration = warmup ? index + 1 : index - options.warmup + 1;
    for (const factory of orderedFactories(factories, index)) {
      const runtime = factory.create();
      let session = null;
      const startedAt = new Date().toISOString();
      const started = performance.now();
      try {
        await runtime.launch();
        session = await runtime.newSession();
        const navigation = await session.navigate(`${server.origin}/stylo/startup.html?iteration=${index}`, {
          waitUntil: "domcontentloaded",
          timeoutMs: options.timeoutMs,
        });
        const ready = await session.evaluate("document.querySelector('#fixture')?.dataset.ready");
        if (ready !== "true") throw new Error(`startup fixture validation failed: ${ready}`);
        const firstDocumentMs = performance.now() - started;
        const memory = await sampleProcessTree(runtime.pid, memoryOptions(options));
        addRecord(records, {
          baseline: factory.id,
          workload: "startup",
          iteration,
          warmup,
          startedAt,
          metrics: {
            durationMs: firstDocumentMs,
            processReadyMs: runtime.launchMetrics?.processReadyMs ?? null,
            appStartupMs: runtime.launchMetrics?.appStartupMs ?? null,
            firstSessionMs: session.timings?.durationMs ?? null,
            firstNavigationMs: navigation.durationMs,
            readyRssBytes: memory.rssBytes,
            readyPeakRssBytes: memory.peakRssBytes,
            readyVirtualMemoryBytes: memory.virtualMemoryBytes,
            readyProcessCount: memory.processCount,
            readyThreadCount: memory.threadCount,
          },
        });
      } catch (error) {
        addRecord(records, { baseline: factory.id, workload: "startup", iteration, warmup, startedAt, error });
      } finally {
        await closeSessionAndRuntime(session, runtime);
      }
    }
  }
}

async function runCssParsing(server, factories, options, records) {
  const total = options.warmup + options.iterations;
  for (const factory of factories) {
    const runtime = factory.create();
    let session = null;
    let provenance = null;
    try {
      await runtime.launch();
      session = await runtime.newSession();
      for (let index = 0; index < total; index += 1) {
        const warmup = index < options.warmup;
        const iteration = warmup ? index + 1 : index - options.warmup + 1;
        const startedAt = new Date().toISOString();
        try {
          const navigation = await session.navigate(`${server.origin}/stylo/css-parse.html?iteration=${index}`, {
            waitUntil: "domcontentloaded",
            timeoutMs: options.timeoutMs,
          });
          const target = await session.evaluate("({ className: document.querySelector('#css-target')?.className, sheets: document.styleSheets.length, rules: document.styleSheets[0]?.cssRules?.length ?? null })");
          if (!target?.className) throw new Error("CSS parsing fixture did not create its target");
          if (provenance == null) {
            provenance = await styleEngineProvenance(session);
            requireStyloForKoko(factory, provenance);
          }
          addRecord(records, {
            baseline: factory.id,
            workload: "css-parsing",
            iteration,
            warmup,
            startedAt,
            metrics: {
              durationMs: navigation.durationMs,
              navigationAckMs: navigation.navigationAckMs,
              responseCount: navigation.responseCount,
              cssBytes: server.metadata.cssBytes,
              cssRuleCount: server.metadata.cssRuleCount,
              cssParseThroughputBytesPerSecond: navigation.durationMs > 0
                ? server.metadata.cssBytes / (navigation.durationMs / 1_000)
                : null,
              observedStylesheetCount: target.sheets,
              observedRuleCount: target.rules,
            },
            details: { provenance },
          });
        } catch (error) {
          addRecord(records, { baseline: factory.id, workload: "css-parsing", iteration, warmup, startedAt, error });
        }
      }
    } catch (error) {
      const startedAt = new Date().toISOString();
      addRecord(records, { baseline: factory.id, workload: "css-parsing", iteration: 1, warmup: false, startedAt, error });
    } finally {
      await closeSessionAndRuntime(session, runtime);
    }
  }
}

async function runComputedStyle(server, factories, options, records, kind) {
  const workload = kind === "full" ? "computed-style-full" : "computed-style-incremental";
  const total = options.warmup + options.iterations;
  for (const factory of factories) {
    const runtime = factory.create();
    let session = null;
    try {
      await runtime.launch();
      session = await runtime.newSession();
      await session.navigate(`${server.origin}/stylo/computed-style.html?kind=${kind}`, {
        waitUntil: "domcontentloaded",
        timeoutMs: options.timeoutMs,
      });
      const provenance = await styleEngineProvenance(session);
      requireStyloForKoko(factory, provenance);
      for (let index = 0; index < total; index += 1) {
        const warmup = index < options.warmup;
        const iteration = warmup ? index + 1 : index - options.warmup + 1;
        const startedAt = new Date().toISOString();
        try {
          const expression = `window.__styloPerformance.run(${JSON.stringify(kind)}, ${options.styleReads})`;
          const wallStarted = performance.now();
          const result = await session.evaluate(expression, options.timeoutMs);
          const evaluateWallMs = performance.now() - wallStarted;
          if (result?.status !== "pass") throw new Error(result?.reason ?? "computed-style workload unsupported");
          addRecord(records, {
            baseline: factory.id,
            workload,
            iteration,
            warmup,
            startedAt,
            metrics: {
              durationMs: result.durationMs,
              evaluateWallMs,
              repetitions: result.repetitions,
              nodeCount: result.nodeCount,
              touchedNodes: result.touchedNodes,
              checksum: result.checksum,
            },
            details: { provenance },
          });
        } catch (error) {
          addRecord(records, { baseline: factory.id, workload, iteration, warmup, startedAt, error });
        }
      }
    } catch (error) {
      const startedAt = new Date().toISOString();
      addRecord(records, { baseline: factory.id, workload, iteration: 1, warmup: false, startedAt, error });
    } finally {
      await closeSessionAndRuntime(session, runtime);
    }
  }
}

async function runRepeatedNavigation(server, factories, options, records) {
  for (const factory of factories) {
    const runtime = factory.create();
    let session = null;
    const startedAt = new Date().toISOString();
    try {
      await runtime.launch();
      session = await runtime.newSession();
      for (let index = 0; index < options.warmup; index += 1) {
        await session.navigate(`${server.origin}/stylo/navigation.html?warmup=${index}`, {
          waitUntil: "domcontentloaded",
          timeoutMs: options.timeoutMs,
        });
      }
      const provenance = await styleEngineProvenance(session);
      requireStyloForKoko(factory, provenance);
      const baseline = await sampleProcessTree(runtime.pid, memoryOptions(options));
      let highWaterRssBytes = baseline.peakRssBytes;
      let highWaterVirtualMemoryBytes = baseline.peakVirtualMemoryBytes;
      let last = baseline;
      for (let index = 0; index < options.navigationIterations; index += 1) {
        const navigation = await session.navigate(`${server.origin}/stylo/navigation.html?navigation=${index}`, {
          waitUntil: "domcontentloaded",
          timeoutMs: options.timeoutMs,
        });
        const memory = await sampleProcessTree(runtime.pid, memoryOptions(options));
        highWaterRssBytes = Math.max(highWaterRssBytes, memory.peakRssBytes);
        highWaterVirtualMemoryBytes = Math.max(highWaterVirtualMemoryBytes, memory.peakVirtualMemoryBytes);
        last = memory;
        addRecord(records, {
          baseline: factory.id,
          workload: "repeated-navigation",
          iteration: index + 1,
          warmup: false,
          startedAt,
          metrics: {
            durationMs: navigation.durationMs,
            navigationAckMs: navigation.navigationAckMs,
            rssBytes: memory.rssBytes,
            peakRssBytes: memory.peakRssBytes,
            rssDeltaBytes: memory.rssBytes - baseline.rssBytes,
            rssHighWaterBytes: highWaterRssBytes,
            virtualMemoryBytes: memory.virtualMemoryBytes,
            peakVirtualMemoryBytes: memory.peakVirtualMemoryBytes,
            virtualMemoryHighWaterBytes: highWaterVirtualMemoryBytes,
            processCount: memory.processCount,
            threadCount: memory.threadCount,
          },
          details: { provenance },
        });
      }
      addRecord(records, {
        baseline: factory.id,
        workload: "repeated-navigation-high-water",
        iteration: 1,
        warmup: false,
        startedAt,
        metrics: {
          navigationCount: options.navigationIterations,
          baselineRssBytes: baseline.rssBytes,
          finalRssBytes: last.rssBytes,
          rssDeltaBytes: last.rssBytes - baseline.rssBytes,
          rssHighWaterBytes: highWaterRssBytes,
          baselineVirtualMemoryBytes: baseline.virtualMemoryBytes,
          finalVirtualMemoryBytes: last.virtualMemoryBytes,
          virtualMemoryDeltaBytes: last.virtualMemoryBytes - baseline.virtualMemoryBytes,
          virtualMemoryHighWaterBytes: highWaterVirtualMemoryBytes,
          processCount: last.processCount,
          threadCount: last.threadCount,
        },
        details: { provenance },
      });
    } catch (error) {
      addRecord(records, { baseline: factory.id, workload: "repeated-navigation", iteration: 1, warmup: false, startedAt, error });
    } finally {
      await closeSessionAndRuntime(session, runtime);
    }
  }
}

async function runConcurrentSessions(server, factories, options, records) {
  const total = options.concurrencyWarmup + options.concurrencyIterations;
  for (const density of options.densities) {
    const workload = `concurrent-${density}-sessions`;
    for (let index = 0; index < total; index += 1) {
      const warmup = index < options.concurrencyWarmup;
      const iteration = warmup ? index + 1 : index - options.concurrencyWarmup + 1;
      for (const factory of orderedFactories(factories, index)) {
        const runtime = factory.create();
        const sessions = [];
        const startedAt = new Date().toISOString();
        try {
          await runtime.launch();
          const baseline = await sampleProcessTree(runtime.pid, memoryOptions(options));
          const createStarted = performance.now();
          sessions.push(...await Promise.all(Array.from({ length: density }, () => runtime.newSession())));
          const sessionCreateMs = performance.now() - createStarted;
          const navigationStarted = performance.now();
          const navigations = await Promise.all(sessions.map((session, sessionIndex) => session.navigate(
            `${server.origin}/stylo/navigation.html?concurrent=${index}&session=${sessionIndex}`,
            { waitUntil: "domcontentloaded", timeoutMs: options.timeoutMs },
          )));
          const navigationWallMs = performance.now() - navigationStarted;
          const ready = await Promise.all(sessions.map((session) => session.evaluate(
            "document.querySelector('#stylo-performance-root')?.children.length",
          )));
          if (ready.some((count) => count !== options.styleNodes)) throw new Error("concurrent fixture validation failed");
          const loaded = await sampleProcessTree(runtime.pid, memoryOptions(options));
          const incrementalRssBytes = loaded.rssBytes - baseline.rssBytes;
          addRecord(records, {
            baseline: factory.id,
            workload,
            iteration,
            warmup,
            startedAt,
            metrics: {
              durationMs: navigationWallMs,
              navigationWallMs,
              totalNavigationMs: navigations.reduce((sum, navigation) => sum + navigation.durationMs, 0),
              sessionCreateMs,
              sessionCount: density,
              throughputPagesPerSecond: density / (navigationWallMs / 1_000),
              baselineRssBytes: baseline.rssBytes,
              rssBytes: loaded.rssBytes,
              peakRssBytes: loaded.peakRssBytes,
              incrementalRssBytes,
              rssPerSessionBytes: incrementalRssBytes / density,
              rssHighWaterBytes: Math.max(baseline.peakRssBytes, loaded.peakRssBytes),
              baselineVirtualMemoryBytes: baseline.virtualMemoryBytes,
              virtualMemoryBytes: loaded.virtualMemoryBytes,
              peakVirtualMemoryBytes: loaded.peakVirtualMemoryBytes,
              virtualMemoryHighWaterBytes: Math.max(baseline.peakVirtualMemoryBytes, loaded.peakVirtualMemoryBytes),
              incrementalVirtualMemoryBytes: loaded.virtualMemoryBytes - baseline.virtualMemoryBytes,
              processCount: loaded.processCount,
              threadCount: loaded.threadCount,
              averageCpuPercent: loaded.averageCpuPercent,
            },
          });
        } catch (error) {
          addRecord(records, { baseline: factory.id, workload, iteration, warmup, startedAt, error });
        } finally {
          for (const session of sessions.reverse()) await session.close().catch(() => {});
          await runtime.close().catch(() => {});
        }
      }
    }
  }
}

function summarize(records) {
  const groups = new Map();
  for (const record of records.filter((entry) => !entry.warmup)) {
    const key = `${record.baseline}\u0000${record.workload}`;
    const group = groups.get(key) ?? {
      baseline: record.baseline,
      workload: record.workload,
      attempts: 0,
      successes: 0,
      failures: 0,
      metrics: {},
    };
    group.attempts += 1;
    if (record.success) {
      group.successes += 1;
      for (const [name, value] of Object.entries(record.metrics)) {
        if (!Number.isFinite(value)) continue;
        (group.metrics[name] ??= []).push(value);
      }
    } else {
      group.failures += 1;
    }
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    successRate: group.attempts ? group.successes / group.attempts : 0,
    metrics: Object.fromEntries(Object.entries(group.metrics).map(([name, values]) => [name, describe(values)])),
  }));
}

function validateEnvironment(options) {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22+ is required");
  options.kokoBin = resolve(projectRoot, options.kokoBin);
  if (options.baselines.includes("koko-cdp") && !existsSync(options.kokoBin)) {
    throw new Error(`Koko binary not found: ${options.kokoBin}`);
  }
  if (options.baselines.includes("chromium-cdp") || options.baselines.includes("playwright-chromium")) {
    options.chromeBin = detectChrome(options.chromeBin);
  }
  if (options.output == null) options.output = resolve(projectRoot, "bench-results", "stylo-performance", `${Date.now()}.json`);
  else options.output = resolve(projectRoot, options.output);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  validateEnvironment(options);
  const factories = createAdapterFactories(options.baselines, {
    projectRoot,
    kokoBin: options.kokoBin,
    chromeBin: options.chromeBin,
    timeoutMs: options.timeoutMs,
  });
  const server = await startPerformanceServer(options);
  const records = [];
  try {
    process.stdout.write(`\nStylo performance (${options.baselines.join(", ")})\n`);
    if (options.workloads.includes("startup")) await runStartup(server, factories, options, records);
    if (options.workloads.includes("css-parsing")) await runCssParsing(server, factories, options, records);
    if (options.workloads.includes("computed-style-full")) await runComputedStyle(server, factories, options, records, "full");
    if (options.workloads.includes("computed-style-incremental")) await runComputedStyle(server, factories, options, records, "incremental");
    if (options.workloads.includes("repeated-navigation")) await runRepeatedNavigation(server, factories, options, records);
    if (options.workloads.includes("concurrent-sessions")) await runConcurrentSessions(server, factories, options, records);
  } finally {
    await server.close();
  }

  const report = {
    schemaVersion: 1,
    suite: "stylo-performance",
    startedAt: new Date().toISOString(),
    options,
    limits,
    fixture: server.metadata,
    records,
    summary: summarize(records),
  };
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${options.output}\n`);
  const failures = records.filter((record) => !record.warmup && !record.success).length;
  if (failures > 0 && !options.allowFailures) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});

