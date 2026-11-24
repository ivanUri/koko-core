#!/usr/bin/env node
import { createServer } from "node:http";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapterFactories, detectChrome } from "../adapters/index.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cssFixtureDirectory = join(projectRoot, "src/browser/tests/css");
const defaultTimeoutMs = 30_000;
const styloFixtureNames = [
  "stylo_adopted_sheets.html",
  "stylo_cascade.html",
  "stylo_class_mutation.html",
  "stylo_custom_properties.html",
  "stylo_dynamic_stylesheet.html",
  "stylo_important.html",
  "stylo_inheritance.html",
  "stylo_inline.html",
  "stylo_lifecycle.html",
  "stylo_media.html",
  "stylo_pseudo.html",
  "stylo_shadow_root.html",
];

function parseArgs(argv) {
  const options = {
    mode: "all",
    kokoBin: "zig-out/bin/koko",
    chromeBin: null,
    iterations: 10,
    warmup: 2,
    timeoutMs: defaultTimeoutMs,
    output: null,
    baselines: ["koko-cdp", "chromium-cdp"],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => argv[++index] ?? (() => { throw new Error(`Missing value after ${argument}`); })();
    if (argument === "--mode") options.mode = next();
    else if (argument === "--koko-bin") options.kokoBin = next();
    else if (argument === "--chrome-bin") options.chromeBin = next();
    else if (argument === "--iterations") options.iterations = Number(next());
    else if (argument === "--warmup") options.warmup = Number(next());
    else if (argument === "--timeout-ms") options.timeoutMs = Number(next());
    else if (argument === "--output") options.output = next();
    else if (argument === "--baseline") options.baselines = next().split(",").map((value) => value.trim()).filter(Boolean);
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!["tests", "bench", "all"].includes(options.mode)) throw new Error("--mode must be tests, bench, or all");
  if (!Number.isInteger(options.iterations) || options.iterations < 1) throw new Error("--iterations must be an integer >= 1");
  if (!Number.isInteger(options.warmup) || options.warmup < 0) throw new Error("--warmup must be an integer >= 0");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("--timeout-ms must be an integer >= 1");
  return options;
}

function usage() {
  return `Stylo differential tests and benchmark\n\n` +
    `  node bench/suites/stylo-differential.mjs [options]\n\n` +
    `  --mode <tests|bench|all> --baseline <koko-cdp,chromium-cdp>\n` +
    `  --koko-bin <path> --chrome-bin <path> --iterations <n> --warmup <n>\n` +
    `  --timeout-ms <n> --output <json-path>\n`;
}

function contentType(pathname) {
  if (pathname.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  return "text/plain; charset=utf-8";
}

function benchmarkHtml() {
  return `<!doctype html><meta charset="utf-8"><style>
    :root { --stylo-bench-color: rgb(31, 41, 51); --stylo-bench-gap: 4px; }
    .stylo-bench-node { color: var(--stylo-bench-color); margin: var(--stylo-bench-gap); padding: 2px; border: 1px solid rgb(61, 71, 81); }
    .stylo-bench-node.hot { color: rgb(91, 101, 111); padding: 3px; }
  </style><body><main id="stylo-bench-root"></main><script>
    const root = document.querySelector("#stylo-bench-root");
    for (let index = 0; index < 160; index += 1) {
      const node = document.createElement("div");
      node.className = "stylo-bench-node";
      node.textContent = "stylo-bench-" + index;
      root.appendChild(node);
    }
    const properties = ["color", "margin-top", "margin-right", "padding-top", "padding-right", "border-top-width", "border-top-style", "font-size", "line-height", "display"];
    const nodes = [...document.querySelectorAll(".stylo-bench-node")];
    function readFull() {
      let checksum = 0;
      for (const node of nodes) {
        const style = getComputedStyle(node);
        for (const property of properties) checksum += style.getPropertyValue(property).length;
      }
      return checksum;
    }
    function readIncremental() {
      const node = nodes[0];
      node.classList.toggle("hot");
      const style = getComputedStyle(node);
      let checksum = 0;
      for (const property of properties) checksum += style.getPropertyValue(property).length;
      return checksum;
    }
    function mutateInvalidation() {
      let checksum = 0;
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        node.classList.toggle("hot", index % 2 === 0);
        checksum += getComputedStyle(node).getPropertyValue("color").length;
      }
      return checksum;
    }
    window.__styloBench = {
      run(kind, iterations) {
        if (typeof getComputedStyle !== "function") return { status: "unsupported", reason: "getComputedStyle is unavailable" };
        const operation = kind === "full" ? readFull : kind === "incremental" ? readIncremental : kind === "mutation-invalidation" ? mutateInvalidation : null;
        if (!operation) return { status: "unsupported", reason: "unknown benchmark workload" };
        let checksum = 0;
        const started = performance.now();
        for (let index = 0; index < iterations; index += 1) checksum += operation();
        return { status: "pass", durationMs: performance.now() - started, operations: iterations, checksum, nodeCount: nodes.length };
      },
    };
  </script></body>`;
}

async function startFixtureServer(fixtureNames) {
  const files = new Map();
  for (const name of [...fixtureNames, "stylo_fixture.js"]) files.set(name, await readFile(join(cssFixtureDirectory, name), "utf8"));
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    if (pathname === "/stylo/benchmark.html") {
      const body = benchmarkHtml();
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(body);
      return;
    }
    const name = pathname.startsWith("/stylo/css/") ? pathname.slice("/stylo/css/".length) : null;
    const body = name ? files.get(name) : null;
    if (!body) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": contentType(name), "cache-control": "no-store" });
    response.end(body);
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())),
  };
}

function normalize(value) {
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ").toLowerCase();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  return value;
}

function sameObservations(left, right) {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

async function waitForFixtureResult(session, timeoutMs) {
  return session.evaluate(`(async () => {
    const deadline = Date.now() + ${timeoutMs};
    while (!window.__styloResult && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return window.__styloResult || { status: "error", reason: "fixture did not publish a result" };
  })()`, timeoutMs + 1_000);
}

async function runDifferentialTests(factories, server, fixtureNames, timeoutMs) {
  const byBaseline = new Map();
  for (const factory of factories) {
    const runtime = factory.create();
    await runtime.launch();
    byBaseline.set(factory.id, { factory, runtime });
  }
  const results = [];
  try {
    for (const fixtureName of fixtureNames) {
      const observations = {};
      for (const { factory, runtime } of byBaseline.values()) {
        let session = null;
        try {
          session = await runtime.newSession();
          await session.navigate(`${server.origin}/stylo/css/${encodeURIComponent(fixtureName)}`, { timeoutMs });
          observations[factory.id] = await waitForFixtureResult(session, timeoutMs);
        } catch (error) {
          observations[factory.id] = { status: "error", reason: `${error.name || "Error"}: ${error.message || error}` };
        } finally {
          await session?.close().catch(() => {});
        }
      }
      const values = Object.values(observations);
      const hasError = values.some((value) => value.status === "error");
      const hasUnsupported = values.some((value) => value.status === "unsupported");
      const allPass = values.length > 0 && values.every((value) => value.status === "pass");
      const firstPass = values.find((value) => value.status === "pass");
      const mismatch = allPass && firstPass && values.some((value) => !sameObservations(firstPass.observations, value.observations));
      const status = hasError ? "error" : mismatch ? "mismatch" : hasUnsupported ? "unsupported" : "pass";
      results.push({ fixture: fixtureName, status, observations });
      process.stdout.write(`  ${fixtureName}: ${status}\n`);
    }
  } finally {
    for (const { runtime } of byBaseline.values()) await runtime.close().catch(() => {});
  }
  return results;
}

async function runBenchmarks(factories, server, options) {
  const results = [];
  const url = `${server.origin}/stylo/benchmark.html`;
  for (const factory of factories) {
    const runtime = factory.create();
    await runtime.launch();
    let session = null;
    try {
      session = await runtime.newSession();
      const parseTotal = options.warmup + options.iterations;
      for (let index = 0; index < parseTotal; index += 1) {
        const warmup = index < options.warmup;
        const iteration = warmup ? index + 1 : index - options.warmup + 1;
        const navigation = await session.navigate(`${url}?parse=${index}`, { timeoutMs: options.timeoutMs });
        results.push({
          baseline: factory.id,
          workload: "parse-and-initial-style",
          iteration,
          warmup,
          result: { status: "pass", durationMs: navigation.durationMs, navigationAckMs: navigation.navigationAckMs, responseCount: navigation.responseCount },
        });
      }
      for (const workload of ["full", "incremental", "mutation-invalidation"]) {
        const total = options.warmup + options.iterations;
        for (let index = 0; index < total; index += 1) {
          const warmup = index < options.warmup;
          const iteration = warmup ? index + 1 : index - options.warmup + 1;
          const value = await session.evaluate(`window.__styloBench.run(${JSON.stringify(workload)}, ${options.iterations})`, options.timeoutMs);
          results.push({ baseline: factory.id, workload, iteration, warmup, result: value });
        }
      }
      const total = options.warmup + options.iterations;
      for (let index = 0; index < total; index += 1) {
        const warmup = index < options.warmup;
        const iteration = warmup ? index + 1 : index - options.warmup + 1;
        const navigation = await session.navigate(`${url}?navigation=${index}`, { timeoutMs: options.timeoutMs });
        results.push({
          baseline: factory.id,
          workload: "repeated-navigation",
          iteration,
          warmup,
          result: { status: "pass", durationMs: navigation.durationMs, navigationAckMs: navigation.navigationAckMs, responseCount: navigation.responseCount },
        });
      }
    } finally {
      await session?.close().catch(() => {});
      await runtime.close().catch(() => {});
    }
  }
  for (const result of results) {
    process.stdout.write(`  ${result.baseline}/${result.workload} #${result.iteration}${result.warmup ? " warmup" : ""}: ${result.result.status}\n`);
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const availableFixtures = new Set(await readdir(cssFixtureDirectory));
  const fixtureNames = styloFixtureNames.filter((name) => availableFixtures.has(name));
  const missingFixtures = styloFixtureNames.filter((name) => !availableFixtures.has(name));
  if (missingFixtures.length) throw new Error(`Missing Stylo fixture(s): ${missingFixtures.join(", ")}`);
  const server = await startFixtureServer(fixtureNames);
  const chromeBin = options.baselines.includes("chromium-cdp") ? detectChrome(options.chromeBin) : options.chromeBin;
  const factories = createAdapterFactories(options.baselines, {
    projectRoot,
    kokoBin: options.kokoBin,
    chromeBin,
    timeoutMs: options.timeoutMs,
  });
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    mode: options.mode,
    fixtures: fixtureNames,
    options,
  };
  try {
    if (options.mode === "tests" || options.mode === "all") {
      report.tests = await runDifferentialTests(factories, server, fixtureNames, options.timeoutMs);
    }
    if (options.mode === "bench" || options.mode === "all") {
      report.benchmarks = await runBenchmarks(factories, server, options);
    }
  } finally {
    await server.close();
  }
  const failures = [...(report.tests ?? []), ...(report.benchmarks ?? [])].filter((result) => ["error", "mismatch"].includes(result.status ?? result.result?.status));
  const output = options.output ? resolve(options.output) : resolve("bench-results", "stylo", `${Date.now()}.json`);
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${output}\n`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
