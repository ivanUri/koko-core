#!/usr/bin/env node
/*
 * Layout/text differential probe for the post-Stylo Taffy/Parley milestone.
 *
 * This suite is deliberately standalone. It uses the existing direct-CDP
 * adapters and loopback server but does not alter the benchmark runner or
 * any Stylo benchmark. It reports API gaps and geometry mismatches instead of
 * turning missing layout functionality into a false pass.
 */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapterFactories, detectChrome } from "../adapters/index.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureDirectory = join(projectRoot, "bench", "fixtures");
const fixtureNames = [
  "layout-flex-grid.html",
  "layout-text.html",
  "layout-geometry.html",
  "layout-lifecycle.html",
];

function parseArgs(argv) {
  const options = {
    kokoBin: "zig-out/bin/koko",
    chromeBin: null,
    iterations: 3,
    warmup: 1,
    timeoutMs: 30_000,
    output: null,
    baselines: ["koko-cdp", "chromium-cdp"],
    allowMismatches: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value after ${argument}`);
      return value;
    };
    if (argument === "--koko-bin") options.kokoBin = next();
    else if (argument === "--chrome-bin") options.chromeBin = next();
    else if (argument === "--iterations") options.iterations = Number(next());
    else if (argument === "--warmup") options.warmup = Number(next());
    else if (argument === "--timeout-ms") options.timeoutMs = Number(next());
    else if (argument === "--output") options.output = next();
    else if (argument === "--baseline") options.baselines = next().split(",").map((value) => value.trim()).filter(Boolean);
    else if (argument === "--allow-mismatches") options.allowMismatches = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.iterations) || options.iterations < 1) throw new Error("--iterations must be an integer >= 1");
  if (!Number.isInteger(options.warmup) || options.warmup < 0) throw new Error("--warmup must be an integer >= 0");
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("--timeout-ms must be an integer >= 1");
  return options;
}

function usage() {
  return `Taffy/Parley layout and text differential probe\n\n` +
    `  node bench/suites/taffy-parley-differential.mjs [options]\n\n` +
    `  --koko-bin <path> --chrome-bin <path>\n` +
    `  --baseline <koko-cdp,chromium-cdp>\n` +
    `  --warmup <n> --iterations <n> --timeout-ms <n>\n` +
    `  --output <json-path> --allow-mismatches\n`;
}

async function startFixtureServer() {
  const files = new Map();
  for (const name of fixtureNames) files.set(name, await readFile(join(fixtureDirectory, name), "utf8"));
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const name = pathname.startsWith("/layout/") ? pathname.slice("/layout/".length) : null;
    const body = name ? files.get(name) : null;
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
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolvePromise, reject) => server.close((error) => error ? reject(error) : resolvePromise())),
  };
}

function probeFixture(fixtureName) {
  const round = (value) => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
  const rect = (element) => {
    if (!element || typeof element.getBoundingClientRect !== "function") return null;
    const value = element.getBoundingClientRect();
    return { x: round(value.x), y: round(value.y), width: round(value.width), height: round(value.height), top: round(value.top), left: round(value.left), right: round(value.right), bottom: round(value.bottom) };
  };
  const style = (element, property) => element && typeof getComputedStyle === "function" ? getComputedStyle(element).getPropertyValue(property).trim() : null;
  const unsupported = (reason, details = {}) => ({ status: "unsupported", reason, details });

  try {
    if (fixtureName === "layout-flex-grid.html") {
      const flex = document.querySelector("#flex");
      const grid = document.querySelector("#grid");
      const flexItems = [...flex.children];
      const gridItems = [...grid.children];
      if (!flex || !grid || typeof flex.getBoundingClientRect !== "function") return unsupported("layout DOM or geometry API unavailable");
      return {
        status: "pass",
        observations: {
          flex: { display: style(flex, "display"), rect: rect(flex), gap: style(flex, "gap"), items: flexItems.map((item) => rect(item)), widths: flexItems.map((item) => round(item.getBoundingClientRect().width)) },
          grid: { display: style(grid, "display"), rect: rect(grid), columns: style(grid, "grid-template-columns"), rows: style(grid, "grid-template-rows"), items: gridItems.map((item) => rect(item)) },
        },
      };
    }
    if (fixtureName === "layout-text.html") {
      const box = document.querySelector("#text-box");
      const latin = document.querySelector("#latin");
      const bidi = document.querySelector("#bidi");
      if (!box || !latin || typeof box.getClientRects !== "function") return unsupported("text or client-rect API unavailable");
      return {
        status: "pass",
        observations: {
          box: { rect: rect(box), clientWidth: box.clientWidth, scrollWidth: box.scrollWidth, lineHeight: style(box, "line-height"), whiteSpace: style(box, "white-space") },
          latin: { rect: rect(latin), clientRects: [...latin.getClientRects()].map((value) => ({ x: round(value.x), y: round(value.y), width: round(value.width), height: round(value.height) })) },
          bidi: { rect: rect(bidi), direction: style(bidi, "direction"), unicodeBidi: style(bidi, "unicode-bidi") },
          textLength: box.textContent.length,
        },
      };
    }
    if (fixtureName === "layout-geometry.html") {
      const outer = document.querySelector("#outer");
      const inner = document.querySelector("#inner");
      if (!outer || !inner || typeof outer.getBoundingClientRect !== "function") return unsupported("geometry API unavailable");
      const outerRect = outer.getBoundingClientRect();
      const pointElement = typeof document.elementFromPoint === "function"
        ? document.elementFromPoint(inner.getBoundingClientRect().left + 10, inner.getBoundingClientRect().top + 10)?.id ?? null
        : null;
      return {
        status: "pass",
        observations: {
          outer: { rect: rect(outer), offsetWidth: outer.offsetWidth, offsetHeight: outer.offsetHeight, clientWidth: outer.clientWidth, clientHeight: outer.clientHeight, scrollWidth: outer.scrollWidth, scrollHeight: outer.scrollHeight },
          inner: { rect: rect(inner), offsetWidth: inner.offsetWidth, offsetHeight: inner.offsetHeight, clientWidth: inner.clientWidth, clientHeight: inner.clientHeight, offsetTop: inner.offsetTop, offsetLeft: inner.offsetLeft },
          pointElement,
          viewport: { width: window.innerWidth, height: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY, outerTop: round(outerRect.top) },
        },
      };
    }
    if (fixtureName === "layout-lifecycle.html") {
      const value = window.__kokoLayoutLifecycle;
      if (!value) return unsupported("lifecycle script did not execute");
      return { status: "pass", observations: { count: value.count, checksum: value.checksum, title: document.title, readyState: document.readyState } };
    }
    return { status: "error", reason: `unknown fixture ${fixtureName}` };
  } catch (error) {
    return { status: "error", reason: `${error.name || "Error"}: ${error.message || error}` };
  }
}

function compare(left, right, path = "root", differences = []) {
  if (typeof left === "number" && typeof right === "number") {
    if (Math.abs(left - right) > 0.5) differences.push({ path, left, right, reason: "numeric difference > 0.5" });
    return differences;
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    if (left !== right) differences.push({ path, left, right, reason: "value mismatch" });
    return differences;
  }
  if (Array.isArray(left) !== Array.isArray(right) || (Array.isArray(left) && left.length !== right.length)) {
    differences.push({ path, left, right, reason: "shape mismatch" });
    return differences;
  }
  if (Array.isArray(left)) {
    for (let index = 0; index < left.length; index += 1) compare(left[index], right[index], `${path}[${index}]`, differences);
    return differences;
  }
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of [...keys].sort()) compare(left[key], right[key], `${path}.${key}`, differences);
  return differences;
}

function normalizeForComparison(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(normalizeForComparison);
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "readyState").map(([key, item]) => [key, normalizeForComparison(item)]));
}

async function probe(runtime, url, fixtureName, timeoutMs) {
  const session = await runtime.newSession();
  try {
    const navigation = await session.navigate(`${url}?probe=1`, { timeoutMs });
    const started = performance.now();
    const result = await session.evaluate(`(() => { const started = performance.now(); const result = (${probeFixture.toString()})(${JSON.stringify(fixtureName)}); return { result, probeDurationMs: performance.now() - started }; })()`, timeoutMs);
    return { navigation, probeDurationMs: result.probeDurationMs, result: result.result };
  } finally {
    await session.close().catch(() => {});
  }
}

async function runDifferential(factories, server, options) {
  const runtimes = new Map();
  for (const factory of factories) {
    const runtime = factory.create();
    await runtime.launch();
    runtimes.set(factory.id, runtime);
  }
  const results = [];
  try {
    for (const fixtureName of fixtureNames) {
      const observations = {};
      for (const [baseline, runtime] of runtimes) {
        try {
          observations[baseline] = await probe(runtime, `${server.origin}/layout/${fixtureName}`, fixtureName, options.timeoutMs);
        } catch (error) {
          observations[baseline] = { result: { status: "error", reason: `${error.name || "Error"}: ${error.message || error}` } };
        }
      }
      const statuses = Object.values(observations).map((value) => value.result.status);
      const first = Object.values(observations).find((value) => value.result.status === "pass");
      const differences = first ? Object.fromEntries(Object.entries(observations).filter(([, value]) => value.result.status === "pass" && value !== first).map(([baseline, value]) => [baseline, compare(normalizeForComparison(first.result.observations), normalizeForComparison(value.result.observations), "observations")])) : {};
      const hasDifference = Object.values(differences).some((items) => items.length > 0);
      const status = statuses.includes("error") ? "error" : statuses.includes("unsupported") ? "unsupported" : hasDifference ? "mismatch" : "pass";
      results.push({ fixture: fixtureName, status, observations, differences });
      process.stdout.write(`  ${fixtureName}: ${status}\n`);
    }
  } finally {
    for (const runtime of runtimes.values()) await runtime.close().catch(() => {});
  }
  return results;
}

async function runLifecycleBenchmark(factory, server, options) {
  const runtime = factory.create();
  await runtime.launch();
  const session = await runtime.newSession();
  const records = [];
  try {
    const total = options.warmup + options.iterations;
    for (let index = 0; index < total; index += 1) {
      const warmup = index < options.warmup;
      const iteration = warmup ? index + 1 : index - options.warmup + 1;
      const started = performance.now();
      const navigation = await session.navigate(`${server.origin}/layout/layout-lifecycle.html?navigation=${index}`, { timeoutMs: options.timeoutMs });
      const measured = await session.evaluate(`(() => { const started = performance.now(); const result = (${probeFixture.toString()})("layout-lifecycle.html"); return { result, probeDurationMs: performance.now() - started }; })()`, options.timeoutMs);
      records.push({ iteration, warmup, durationMs: performance.now() - started, navigationMs: navigation.durationMs, navigationAckMs: navigation.navigationAckMs, probeDurationMs: measured.probeDurationMs, probe: measured.result });
    }
  } finally {
    await session.close().catch(() => {});
    await runtime.close().catch(() => {});
  }
  return records;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const server = await startFixtureServer();
  const chromeBin = options.baselines.includes("chromium-cdp") ? detectChrome(options.chromeBin) : options.chromeBin;
  const factories = createAdapterFactories(options.baselines, { projectRoot, kokoBin: options.kokoBin, chromeBin, timeoutMs: options.timeoutMs });
  const report = { schemaVersion: 1, suite: "taffy-parley-differential", startedAt: new Date().toISOString(), fixtureNames, options, tests: [], lifecycle: {} };
  try {
    report.tests = await runDifferential(factories, server, options);
    for (const factory of factories) {
      process.stdout.write(`  ${factory.id}/lifecycle-navigation\n`);
      report.lifecycle[factory.id] = await runLifecycleBenchmark(factory, server, options);
    }
  } finally {
    await server.close();
  }
  const failures = report.tests.filter((result) => result.status !== "pass");
  const output = resolve(options.output ?? join("bench-results", "taffy-parley", `${Date.now()}.json`));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${output}\n`);
  if (failures.length && !options.allowMismatches) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
