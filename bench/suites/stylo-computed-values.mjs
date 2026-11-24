#!/usr/bin/env node
/*
 * Provenance-aware Stylo verification.
 *
 * This suite deliberately does not infer Stylo from CSS output. A Koko run is
 * only a Stylo pass when the runtime exposes the diagnostic contract below:
 *
 *   window.__kokoStyleEngine = {
 *     backend: "stylo",
 *     computedStyles: true,
 *   }
 *
 * Until that contract is wired by the runtime, Koko is reported as
 * unsupported, even when its legacy CSS engine happens to produce matching
 * values. Chromium is a reference implementation and is never reported as a
 * Stylo pass.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapterFactories, detectChrome } from "../adapters/index.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixturePath = join(projectRoot, "src/browser/tests/css/stylo_computed_values_verification.html");
const defaultTimeoutMs = 30_000;
const expected = {
  color: "rgb(70, 80, 90)",
  marginTop: "6px",
  paddingTop: "3px",
  display: "block",
  customAccent: "rgb(17, 34, 51)",
  childColor: "rgb(70, 80, 90)",
};

function parseArgs(argv) {
  const options = {
    kokoBin: "zig-out/bin/koko",
    chromeBin: null,
    baselines: ["koko-cdp", "chromium-cdp"],
    timeoutMs: defaultTimeoutMs,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => argv[++index] ?? (() => { throw new Error(`Missing value after ${argument}`); })();
    if (argument === "--koko-bin") options.kokoBin = next();
    else if (argument === "--chrome-bin") options.chromeBin = next();
    else if (argument === "--baseline") options.baselines = next().split(",").map((value) => value.trim()).filter(Boolean);
    else if (argument === "--timeout-ms") options.timeoutMs = Number(next());
    else if (argument === "--output") options.output = next();
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("--timeout-ms must be an integer >= 1");
  return options;
}

function usage() {
  return [
    "Provenance-aware Stylo computed-value verification",
    "",
    "  node bench/suites/stylo-computed-values.mjs [options]",
    "",
    "  --baseline <koko-cdp,chromium-cdp>",
    "  --koko-bin <path> --chrome-bin <path> --timeout-ms <n> --output <json-path>",
    "",
  ].join("\\n");
}

async function startServer() {
  const body = await readFile(fixturePath, "utf8");
  const server = createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname !== "/stylo/computed-values.html") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
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
  if (typeof value === "string") return value.trim().replace(/\\s+/g, " ").toLowerCase();
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  return value;
}

function equal(left, right) {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function provenanceStatus(id, probe) {
  if (id !== "koko-cdp") return { status: "reference_pass", reason: "non-Koko reference runtime" };
  const candidate = probe?.provenance;
  if (!candidate || candidate.backend !== "stylo" || candidate.computedStyles !== true) {
    return {
      status: "unsupported",
      reason: "Koko Stylo provenance contract is unavailable; computed values cannot prove the backend",
      details: { required: { backend: "stylo", computedStyles: true }, received: candidate ?? null },
    };
  }
  return { status: "provenance_confirmed" };
}

async function waitForProbe(session, timeoutMs) {
  return session.evaluate(`(async () => {
    const deadline = Date.now() + ${timeoutMs};
    while (!window.__styloComputedVerification && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const result = window.__styloComputedVerification || { status: "error", reason: "fixture did not publish a result" };
    let provenance = null;
    try {
      provenance = window.__kokoStyleEngine || window.__kokoStylo || null;
    } catch (error) {
      provenance = { readError: String(error) };
    }
    return { result, provenance };
  })()`, timeoutMs + 1_000);
}

async function run(factory, server, timeoutMs) {
  const runtime = factory.create();
  try {
    await runtime.launch();
    const session = await runtime.newSession();
    try {
      await session.navigate(`${server.origin}/stylo/computed-values.html`, { timeoutMs });
      const probe = await waitForProbe(session, timeoutMs);
      if (probe.result.status === "error") return { baseline: factory.id, status: "error", reason: probe.result.reason, probe };
      if (probe.result.status === "unsupported") return { baseline: factory.id, status: "unsupported", reason: probe.result.reason, probe };
      if (!probe.result.observations) return { baseline: factory.id, status: "error", reason: "fixture returned no observations", probe };
      const valuesMatch = equal(probe.result.observations, { ...expected, pseudoContent: '"stylo"', pseudoDisplay: "inline-block" });
      const provenance = provenanceStatus(factory.id, probe);
      if (provenance.status === "unsupported") return { baseline: factory.id, ...provenance, observations: probe.result.observations };
      if (!valuesMatch) return { baseline: factory.id, status: "mismatch", reason: "computed values differ from the verification vector", expected, observations: probe.result.observations, provenance: probe.provenance };
      return { baseline: factory.id, status: factory.id === "koko-cdp" ? "pass" : "reference_pass", observations: probe.result.observations, provenance: probe.provenance };
    } finally {
      await session.close().catch(() => {});
    }
  } catch (error) {
    return { baseline: factory.id, status: "error", reason: `${error.name || "Error"}: ${error.message || error}` };
  } finally {
    await runtime.close().catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const server = await startServer();
  const chromeBin = options.baselines.includes("chromium-cdp") ? detectChrome(options.chromeBin) : options.chromeBin;
  const factories = createAdapterFactories(options.baselines, {
    projectRoot,
    kokoBin: options.kokoBin,
    chromeBin,
    timeoutMs: options.timeoutMs,
  });
  const report = {
    schemaVersion: 1,
    suite: "stylo-computed-values",
    startedAt: new Date().toISOString(),
    options,
    expected,
    provenanceContract: { global: "window.__kokoStyleEngine", backend: "stylo", computedStyles: true },
    results: [],
  };
  try {
    for (const factory of factories) {
      const result = await run(factory, server, options.timeoutMs);
      report.results.push(result);
      process.stdout.write(`  ${result.baseline}: ${result.status}${result.reason ? ` — ${result.reason}` : ""}\n`);
    }
  } finally {
    await server.close();
  }
  const output = options.output ? resolve(options.output) : resolve("bench-results", "stylo", `${Date.now()}-computed-values.json`);
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${output}\n`);
  if (report.results.some(({ status }) => ["error", "mismatch"].includes(status))) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
