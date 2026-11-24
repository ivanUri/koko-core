#!/usr/bin/env node
/*
 * Bounded Stylo validation matrix.
 *
 * This is a harness lane, not a WPT runner. It reports the exact fixture
 * observations for Koko and Chromium and never treats a matching string as
 * proof of Stylo provenance. The matrix intentionally stays small enough for
 * local differential runs while covering the integration seams most likely to
 * regress.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapterFactories, detectChrome } from "../adapters/index.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const cssFixtureDirectory = join(projectRoot, "src/browser/tests/css");
const matrixFixtureName = "stylo_validation_matrix.html";
const teardownFixtureName = "stylo_validation_teardown.html";
const defaultTimeoutMs = 20_000;
const defaultIterations = 3;
const defaultWarmup = 1;

const expected = {
  selectorCombinators: {
    descendant: "rgb(11, 21, 31)",
    child: "rgb(41, 51, 61)",
    adjacent: "rgb(71, 81, 91)",
    generalSibling: "rgb(101, 111, 121)",
  },
  important: "rgb(7, 8, 9)",
  customProperties: {
    accent: "rgb(18, 28, 38)",
    color: "rgb(18, 28, 38)",
    marginTop: "11px",
  },
  pseudoElements: {
    beforeContent: '"before"',
    beforeDisplay: "inline-block",
    beforeColor: "rgb(131, 141, 151)",
    afterContent: '"after"',
    afterDisplay: "block",
    afterColor: "rgb(161, 171, 181)",
  },
  dynamicStylesheet: {
    insertedColor: "rgb(111, 121, 131)",
    replacedColor: "rgb(141, 151, 161)",
    insertedPaddingTop: "4px",
    replacedPaddingTop: "7px",
    insertedRuleCount: 1,
    replacedRuleCount: 1,
    deletedRuleCount: 0,
  },
  inlineMutation: {
    color: "rgb(171, 181, 191)",
    token: "17px",
    priority: "important",
  },
};

function parseArgs(argv) {
  const options = {
    mode: "all",
    kokoBin: "zig-out/bin/koko",
    chromeBin: null,
    baselines: ["koko-cdp", "chromium-cdp"],
    iterations: defaultIterations,
    warmup: defaultWarmup,
    timeoutMs: defaultTimeoutMs,
    output: null,
    allowMismatches: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => argv[++index] ?? (() => { throw new Error(`Missing value after ${argument}`); })();
    if (argument === "--mode") options.mode = next();
    else if (argument === "--koko-bin") options.kokoBin = next();
    else if (argument === "--chrome-bin") options.chromeBin = next();
    else if (argument === "--baseline") options.baselines = next().split(",").map((value) => value.trim()).filter(Boolean);
    else if (argument === "--iterations") options.iterations = Number(next());
    else if (argument === "--warmup") options.warmup = Number(next());
    else if (argument === "--timeout-ms") options.timeoutMs = Number(next());
    else if (argument === "--output") options.output = next();
    else if (argument === "--allow-mismatches") options.allowMismatches = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!["tests", "bench", "all"].includes(options.mode)) throw new Error("--mode must be tests, bench, or all");
  if (!Number.isInteger(options.iterations) || options.iterations < 1 || options.iterations > 50) {
    throw new Error("--iterations must be an integer between 1 and 50");
  }
  if (!Number.isInteger(options.warmup) || options.warmup < 0 || options.warmup > 20) {
    throw new Error("--warmup must be an integer between 0 and 20");
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) throw new Error("--timeout-ms must be an integer >= 1");
  return options;
}

function usage() {
  return [
    "Bounded Stylo CSS validation matrix",
    "",
    "  node bench/suites/stylo-validation.mjs [options]",
    "",
    "  --mode <tests|bench|all>",
    "  --baseline <koko-cdp,chromium-cdp>",
    "  --koko-bin <path> --chrome-bin <path>",
    "  --iterations <1..50> --warmup <0..20> --timeout-ms <n>",
    "  --output <json-path> --allow-mismatches",
    "",
  ].join("\n");
}

async function startFixtureServer() {
  const files = new Map();
  for (const name of [matrixFixtureName, teardownFixtureName]) {
    files.set(name, await readFile(join(cssFixtureDirectory, name), "utf8"));
  }
  const server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    const name = pathname.startsWith("/stylo/validation/") ? pathname.slice("/stylo/validation/".length) : null;
    const body = name ? files.get(name) : null;
    if (!body) {
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
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ").toLowerCase();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  return value;
}

function equal(left, right) {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function difference(expectedValue, observedValue) {
  if (equal(expectedValue, observedValue)) return null;
  return { expected: expectedValue, observed: observedValue };
}

function matrixExpression() {
  return `(() => {
    const value = (element, property, pseudo) => {
      if (!element) throw new Error("missing element for " + property);
      const style = getComputedStyle(element, pseudo);
      const result = style.getPropertyValue(property);
      if (typeof result !== "string") throw new Error("non-string computed value for " + property);
      return result.trim();
    };
    const selector = (query, property = "color") => value(document.querySelector(query), property);
    const result = {
      selectorCombinators: {
        descendant: selector("#selector-root .descendant-shell .descendant-target"),
        child: selector("#selector-root > .child-target"),
        adjacent: selector("#selector-root > .sibling-a + .adjacent-target"),
        generalSibling: selector("#selector-root > .sibling-a ~ .general-target"),
      },
      important: selector("#important-target"),
      customProperties: {
        accent: value(document.querySelector("#custom-target"), "--stylo-validation-accent"),
        color: selector("#custom-target"),
        marginTop: value(document.querySelector("#custom-target"), "margin-top"),
      },
      pseudoElements: {
        beforeContent: value(document.querySelector("#pseudo-target"), "content", "::before"),
        beforeDisplay: value(document.querySelector("#pseudo-target"), "display", "::before"),
        beforeColor: value(document.querySelector("#pseudo-target"), "color", "::before"),
        afterContent: value(document.querySelector("#pseudo-target"), "content", "::after"),
        afterDisplay: value(document.querySelector("#pseudo-target"), "display", "::after"),
        afterColor: value(document.querySelector("#pseudo-target"), "color", "::after"),
      },
    };

    const dynamicTarget = document.querySelector("#dynamic-target");
    const dynamicStyle = document.createElement("style");
    dynamicStyle.id = "stylo-validation-dynamic-style";
    document.head.appendChild(dynamicStyle);
    if (!dynamicStyle.sheet || typeof dynamicStyle.sheet.insertRule !== "function") {
      throw new Error("dynamic CSSStyleSheet mutation API is unavailable");
    }
    dynamicStyle.sheet.insertRule("#dynamic-target { color: rgb(111, 121, 131); padding-top: 4px; }", 0);
    result.dynamicStylesheet = {
      insertedColor: value(dynamicTarget, "color"),
      insertedPaddingTop: value(dynamicTarget, "padding-top"),
      insertedRuleCount: dynamicStyle.sheet.cssRules.length,
    };
    dynamicStyle.textContent = "#dynamic-target { color: rgb(141, 151, 161); padding-top: 7px; }";
    result.dynamicStylesheet.replacedColor = value(dynamicTarget, "color");
    result.dynamicStylesheet.replacedPaddingTop = value(dynamicTarget, "padding-top");
    result.dynamicStylesheet.replacedRuleCount = dynamicStyle.sheet.cssRules.length;
    dynamicStyle.sheet.deleteRule(0);
    result.dynamicStylesheet.deletedRuleCount = dynamicStyle.sheet.cssRules.length;
    dynamicStyle.remove();

    const inlineTarget = document.querySelector("#inline-target");
    inlineTarget.style.setProperty("color", "rgb(171, 181, 191)", "important");
    inlineTarget.style.setProperty("--stylo-validation-inline-token", "17px");
    result.inlineMutation = {
      color: value(inlineTarget, "color"),
      token: value(inlineTarget, "--stylo-validation-inline-token"),
      priority: inlineTarget.style.getPropertyPriority("color"),
    };
    return result;
  })()`;
}

function benchExpression(iterations) {
  return `(() => {
    const nodes = [
      "#selector-root .descendant-target",
      "#selector-root > .child-target",
      "#selector-root > .sibling-a + .adjacent-target",
      "#selector-root > .sibling-a ~ .general-target",
      "#important-target",
      "#custom-target",
      "#pseudo-target",
    ].map((query) => document.querySelector(query));
    const started = performance.now();
    let checksum = 0;
    for (let iteration = 0; iteration < ${iterations}; iteration += 1) {
      for (const node of nodes) checksum += getComputedStyle(node).getPropertyValue("color").length;
      const style = document.createElement("style");
      document.head.appendChild(style);
      style.sheet.insertRule("#dynamic-target { color: rgb(111, 121, 131); }", 0);
      checksum += getComputedStyle(document.querySelector("#dynamic-target")).getPropertyValue("color").length;
      style.sheet.deleteRule(0);
      style.remove();
      const inline = document.querySelector("#inline-target");
      inline.style.setProperty("color", iteration % 2 ? "rgb(171, 181, 191)" : "rgb(181, 191, 201)");
      checksum += getComputedStyle(inline).getPropertyValue("color").length;
    }
    return { status: "pass", durationMs: performance.now() - started, iterations: ${iterations}, checksum };
  })()`;
}

async function waitForPage(session, expectedPage, timeoutMs) {
  return session.evaluate(`(async () => {
    const deadline = Date.now() + ${timeoutMs};
    while (window.__styloValidationPage !== ${JSON.stringify(expectedPage)} && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { page: window.__styloValidationPage || null, readyState: document.readyState };
  })()`, timeoutMs + 1_000);
}

function classifyMatrix(observed) {
  const cases = {};
  for (const [name, expectedValue] of Object.entries(expected)) {
    const observedValue = observed?.[name];
    cases[name] = {
      status: observedValue == null ? "error" : equal(expectedValue, observedValue) ? "pass" : "mismatch",
      difference: difference(expectedValue, observedValue),
      observed: observedValue ?? null,
      expected: expectedValue,
    };
  }
  return cases;
}

async function runTests(factory, server, timeoutMs) {
  const runtime = factory.create();
  const result = { baseline: factory.id, status: "error", cases: {}, navigationTeardown: null };
  try {
    await runtime.launch();
    const session = await runtime.newSession();
    try {
      await session.navigate(`${server.origin}/stylo/validation/${matrixFixtureName}?phase=initial`, { timeoutMs });
      const firstPage = await waitForPage(session, "matrix", timeoutMs);
      const observed = await session.evaluate(matrixExpression(), timeoutMs);
      result.page = firstPage;
      result.observed = observed;
      result.cases = classifyMatrix(observed);

      await session.navigate(`${server.origin}/stylo/validation/${teardownFixtureName}?phase=teardown`, { timeoutMs });
      const teardownPage = await waitForPage(session, "teardown", timeoutMs);
      const teardownTarget = await session.evaluate(`(() => ({
        page: window.__styloValidationPage || null,
        targetColor: getComputedStyle(document.querySelector("#teardown-target")).getPropertyValue("color").trim(),
      }))()`, timeoutMs);
      await session.navigate(`${server.origin}/stylo/validation/${matrixFixtureName}?phase=return`, { timeoutMs });
      const returnPage = await waitForPage(session, "matrix", timeoutMs);
      const navigationTeardown = await session.evaluate(`(() => ({
        page: window.__styloValidationPage || null,
        staleTeardownTarget: Boolean(document.querySelector("#teardown-target")),
        staleDynamicStyle: Boolean(document.querySelector("#stylo-validation-dynamic-style")),
        freshSelectorColor: getComputedStyle(document.querySelector("#selector-root .descendant-target")).getPropertyValue("color").trim(),
      }))()`, timeoutMs);
      result.navigationTeardown = {
        status: teardownPage.page === "teardown" && teardownTarget.page === "teardown" && returnPage.page === "matrix" &&
          navigationTeardown.page === "matrix" && !navigationTeardown.staleTeardownTarget &&
          !navigationTeardown.staleDynamicStyle && equal(navigationTeardown.freshSelectorColor, expected.selectorCombinators.descendant)
          ? "pass" : "mismatch",
        expected: {
          teardownPage: "teardown",
          returnPage: "matrix",
          staleTeardownTarget: false,
          staleDynamicStyle: false,
          freshSelectorColor: expected.selectorCombinators.descendant,
        },
        observed: { teardownPage, teardownTarget, returnPage, navigationTeardown },
      };
      const caseStatuses = Object.values(result.cases).map(({ status }) => status);
      result.status = [...caseStatuses, result.navigationTeardown.status].includes("error") ? "error" :
        [...caseStatuses, result.navigationTeardown.status].includes("mismatch") ? "mismatch" : "pass";
    } finally {
      await session.close().catch(() => {});
    }
  } catch (error) {
    result.reason = `${error.name || "Error"}: ${error.message || error}`;
  } finally {
    await runtime.close().catch(() => {});
  }
  return result;
}

async function runBench(factory, server, options) {
  const runtime = factory.create();
  const results = [];
  try {
    await runtime.launch();
    const session = await runtime.newSession();
    try {
      const total = options.warmup + options.iterations;
      for (let index = 0; index < total; index += 1) {
        const warmup = index < options.warmup;
        const iteration = warmup ? index + 1 : index - options.warmup + 1;
        const navigation = await session.navigate(`${server.origin}/stylo/validation/${matrixFixtureName}?bench=${index}`, { timeoutMs: options.timeoutMs });
        const value = await session.evaluate(benchExpression(options.iterations), options.timeoutMs);
        results.push({
          baseline: factory.id,
          workload: "style-validation-round",
          iteration,
          warmup,
          navigationMs: navigation.durationMs,
          result: value,
        });
      }
    } finally {
      await session.close().catch(() => {});
    }
  } catch (error) {
    results.push({ baseline: factory.id, workload: "style-validation-round", status: "error", reason: `${error.name || "Error"}: ${error.message || error}` });
  } finally {
    await runtime.close().catch(() => {});
  }
  return results;
}

function compareBaselines(testResults) {
  const byBaseline = Object.fromEntries(testResults.map((result) => [result.baseline, result]));
  const ids = Object.keys(byBaseline);
  if (ids.length < 2) return { status: "not-run", reason: "fewer than two baselines were available" };
  const [left, ...rest] = ids;
  const comparisons = [];
  for (const right of rest) {
    const leftResult = byBaseline[left];
    const rightResult = byBaseline[right];
    for (const name of Object.keys(expected)) {
      const leftCase = leftResult.cases?.[name];
      const rightCase = rightResult.cases?.[name];
      comparisons.push({
        case: name,
        left: left,
        right,
        status: leftCase?.status === "pass" && rightCase?.status === "pass" && equal(leftCase.observed, rightCase.observed) ? "match" : "not-comparable",
        leftStatus: leftCase?.status ?? "missing",
        rightStatus: rightCase?.status ?? "missing",
      });
    }
    const leftNavigation = leftResult.navigationTeardown;
    const rightNavigation = rightResult.navigationTeardown;
    comparisons.push({
      case: "navigationTeardown",
      left,
      right,
      status: leftNavigation?.status === "pass" && rightNavigation?.status === "pass" ? "match" : "not-comparable",
      leftStatus: leftNavigation?.status ?? "missing",
      rightStatus: rightNavigation?.status ?? "missing",
    });
  }
  return { status: comparisons.every(({ status }) => status === "match") ? "match" : "differences", comparisons };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const server = await startFixtureServer();
  const skippedBaselines = [];
  let baselineIds = options.baselines;
  let chromeBin = options.chromeBin;
  if (baselineIds.includes("chromium-cdp")) {
    try {
      chromeBin = detectChrome(chromeBin);
    } catch (error) {
      skippedBaselines.push({ baseline: "chromium-cdp", reason: error.message });
      baselineIds = baselineIds.filter((id) => id !== "chromium-cdp");
    }
  }
  const factories = createAdapterFactories(baselineIds, { projectRoot, kokoBin: options.kokoBin, chromeBin, timeoutMs: options.timeoutMs });
  const report = {
    schemaVersion: 1,
    suite: "stylo-validation",
    startedAt: new Date().toISOString(),
    scope: {
      fixture: matrixFixtureName,
      teardownFixture: teardownFixtureName,
      cases: Object.keys(expected),
      wpt: "not-run; this bounded harness is not a WPT runner",
    },
    options,
    skippedBaselines,
    tests: [],
    benchmarks: [],
    differential: null,
  };
  try {
    if (options.mode === "tests" || options.mode === "all") {
      for (const factory of factories) {
        const result = await runTests(factory, server, options.timeoutMs);
        report.tests.push(result);
        process.stdout.write(`  tests/${factory.id}: ${result.status}\n`);
      }
      report.differential = compareBaselines(report.tests);
    }
    if (options.mode === "bench" || options.mode === "all") {
      for (const factory of factories) {
        const results = await runBench(factory, server, options);
        report.benchmarks.push(...results);
        for (const result of results) process.stdout.write(`  bench/${factory.id}/${result.workload}: ${result.status ?? result.result?.status}\n`);
      }
    }
  } finally {
    await server.close();
  }
  const output = options.output ? resolve(options.output) : resolve("bench-results", "stylo", `${Date.now()}-validation.json`);
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Report: ${output}\n`);

  const testFailures = report.tests.some(({ status }) => ["error", "mismatch"].includes(status));
  const benchFailures = report.benchmarks.some(({ status, result }) => ["error", "mismatch"].includes(status ?? result?.status));
  if (!options.allowMismatches && (testFailures || benchFailures)) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
