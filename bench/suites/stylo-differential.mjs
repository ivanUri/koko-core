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
  "stylo_cssom_rule_subtypes.html",
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
    fixture: null,
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
    else if (argument === "--fixture") options.fixture = next();
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
    `  --timeout-ms <n> --fixture <fixture.html> --output <json-path>\n`;
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
    const rawBody = name ? files.get(name) : null;
    const body = rawBody && name.endsWith(".html")
      ? rawBody.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      : rawBody;
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

function evaluateStyloFixture(fixtureName) {
  function unsupported(reason, details = {}) {
    return { status: "unsupported", reason, details };
  }

  function readStyle(element, properties, pseudo = undefined) {
    if (!element || typeof window.getComputedStyle !== "function") return unsupported("getComputedStyle is unavailable");
    let style;
    try {
      style = window.getComputedStyle(element, pseudo);
    } catch (error) {
      return unsupported(`getComputedStyle threw: ${error.name || error}`);
    }
    if (!style || typeof style.getPropertyValue !== "function") return unsupported("computed style object is unavailable");
    const observations = {};
    for (const property of properties) {
      const value = style.getPropertyValue(property);
      if (typeof value !== "string" || value.length === 0) return unsupported(`computed style did not expose ${property}`);
      observations[property] = value;
    }
    return observations;
  }

  try {
    switch (fixtureName) {
      case "stylo_adopted_sheets.html": {
        if (typeof CSSStyleSheet !== "function" || typeof CSSStyleSheet.prototype.replaceSync !== "function") return unsupported("constructable CSSStyleSheet.replaceSync is unavailable");
        if (!("adoptedStyleSheets" in document) || !document.adoptedStyleSheets || typeof document.adoptedStyleSheets[Symbol.iterator] !== "function") return unsupported("Document.adoptedStyleSheets is unavailable");
        const sheet = new CSSStyleSheet();
        sheet.replaceSync("#stylo-target { color: rgb(201, 211, 221); padding-bottom: 8px; }");
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
        const computed = readStyle(document.querySelector("#stylo-target"), ["color", "padding-bottom"]);
        return computed.status ? computed : { status: "pass", observations: { sheetCount: document.adoptedStyleSheets.length, computed } };
      }
      case "stylo_cascade.html": {
        const observations = readStyle(document.querySelector("#stylo-target"), ["color", "padding-top", "border-top-width", "border-top-style"]);
        return observations.status ? observations : { status: "pass", observations };
      }
      case "stylo_class_mutation.html": {
        const target = document.querySelector("#stylo-target");
        const before = readStyle(target, ["color", "margin-top"]);
        if (before.status) return before;
        if (!target.classList || typeof target.classList.add !== "function") return unsupported("classList mutation is unavailable");
        target.classList.add("stylo-active");
        const after = readStyle(target, ["color", "margin-top"]);
        if (after.status) return after;
        target.classList.remove("stylo-active");
        const restored = readStyle(target, ["color", "margin-top"]);
        if (restored.status) return restored;
        return { status: "pass", observations: { before, after, restored } };
      }
      case "stylo_custom_properties.html": {
        const observations = readStyle(document.querySelector("#stylo-target"), ["--stylo-accent", "--stylo-gap", "color", "margin-inline-start"]);
        return observations.status ? observations : { status: "pass", observations };
      }
      case "stylo_dynamic_stylesheet.html": {
        const style = document.createElement("style");
        document.head.appendChild(style);
        if (!style.sheet || typeof style.sheet.insertRule !== "function") return unsupported("dynamic CSSStyleSheet.insertRule is unavailable");
        style.sheet.insertRule("#stylo-target { color: rgb(113, 123, 133); padding-top: 6px; }", style.sheet.cssRules.length);
        const computed = readStyle(document.querySelector("#stylo-target"), ["color", "padding-top"]);
        return computed.status ? computed : { status: "pass", observations: { ruleCount: style.sheet.cssRules.length, computed } };
      }
      case "stylo_important.html": {
        const observations = readStyle(document.querySelector("#stylo-target"), ["color", "background-color"]);
        return observations.status ? observations : { status: "pass", observations };
      }
      case "stylo_inheritance.html": {
        const parentStyle = readStyle(document.querySelector("#stylo-parent"), ["color", "font-family"]);
        const childStyle = readStyle(document.querySelector("#stylo-child"), ["color", "font-family", "line-height"]);
        if (parentStyle.status) return parentStyle;
        if (childStyle.status) return childStyle;
        return { status: "pass", observations: { parent: parentStyle, child: childStyle } };
      }
      case "stylo_inline.html": {
        const target = document.querySelector("#stylo-target");
        if (!target.style || typeof target.style.setProperty !== "function") return unsupported("inline CSSStyleDeclaration is unavailable");
        target.style.setProperty("color", "rgb(61, 71, 81)");
        target.style.setProperty("padding-inline-start", "5px");
        target.style.setProperty("--stylo-inline-token", "13px");
        const style = readStyle(target, ["color", "padding-inline-start", "--stylo-inline-token"]);
        return style.status ? style : { status: "pass", observations: { cssText: target.style.cssText, style } };
      }
      case "stylo_lifecycle.html": {
        const target = document.querySelector("#stylo-target");
        const style = document.createElement("style");
        if (!style || typeof style.remove !== "function") return unsupported("style element lifecycle methods are unavailable");
        style.textContent = "#stylo-target { letter-spacing: 1px; }";
        document.head.appendChild(style);
        const beforeRemoval = readStyle(target, ["letter-spacing"]);
        if (beforeRemoval.status) return beforeRemoval;
        style.remove();
        const afterRemoval = readStyle(target, ["letter-spacing"]);
        if (afterRemoval.status) return afterRemoval;
        document.head.appendChild(style);
        style.textContent = "#stylo-target { letter-spacing: 2px; }";
        const afterReinsert = readStyle(target, ["letter-spacing"]);
        if (afterReinsert.status) return afterReinsert;
        return { status: "pass", observations: { beforeRemoval, afterRemoval, afterReinsert } };
      }
      case "stylo_media.html": {
        if (typeof window.matchMedia !== "function") return unsupported("matchMedia is unavailable");
        const style = readStyle(document.querySelector("#stylo-target"), ["display", "color"]);
        if (style.status) return style;
        return { status: "pass", observations: { mediaMatches: window.matchMedia("screen").matches, style } };
      }
      case "stylo_pseudo.html": {
        const target = document.querySelector("#stylo-target");
        const before = readStyle(target, ["content", "display", "color"], "::before");
        const after = readStyle(target, ["content", "display", "border-top-width"], "::after");
        if (before.status) return before;
        if (after.status) return after;
        return { status: "pass", observations: { before, after } };
      }
      case "stylo_shadow_root.html": {
        const host = document.querySelector("#stylo-host");
        if (typeof host.attachShadow !== "function") return unsupported("Element.attachShadow is unavailable");
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = `<style>:host { display: block; } .stylo-shadow { color: rgb(231, 241, 251); padding-left: 10px; }</style><span class="stylo-shadow">shadow</span>`;
        const computed = readStyle(root.querySelector(".stylo-shadow"), ["color", "padding-left"]);
        return computed.status ? computed : { status: "pass", observations: { hostDisplay: window.getComputedStyle(host).getPropertyValue("display"), computed } };
      }
      case "stylo_cssom_rule_subtypes.html": {
        const missing = ["CSSSupportsRule", "CSSKeyframesRule", "CSSKeyframeRule", "CSSPageRule", "CSSNamespaceRule", "CSSFontFaceRule", "CSSCounterStyleRule"]
          .filter((name) => typeof window[name] !== "function");
        if (missing.length > 0) return unsupported("CSSOM rule subtype constructors are not exposed", { missing });
        if (typeof CSSStyleSheet !== "function" || typeof CSSStyleSheet.prototype.replaceSync !== "function") {
          return unsupported("constructable CSSStyleSheet.replaceSync is unavailable");
        }

        const sheet = new CSSStyleSheet();
        sheet.replaceSync(`@namespace svg url("http://example.test/svg"); @supports (display: grid) { #fixture-target { color: rgb(1, 2, 3); } } @font-face { font-family: fixture; src: local("fixture"); } @page :left { margin: 1cm; } @keyframes fixture-pulse { from { opacity: 0; } 100% { opacity: 1; } } @counter-style fixture-counter { system: cyclic; symbols: "x"; }`);
        const rules = sheet.cssRules;
        const namespaceRule = rules[0];
        const supportsRule = rules[1];
        const fontFaceRule = rules[2];
        const pageRule = rules[3];
        const keyframesRule = rules[4];
        const counterStyleRule = rules[5];
        const assert = (condition, message) => { if (!condition) throw new Error(message); };
        const ruleType = (name, fallback) => typeof CSSRule === "function" && typeof CSSRule[name] === "number" ? CSSRule[name] : fallback;

        assert(namespaceRule instanceof CSSNamespaceRule && namespaceRule.prefix === "svg", "CSSNamespaceRule did not materialize correctly");
        assert(fontFaceRule instanceof CSSFontFaceRule && !fontFaceRule.cssText.includes("\\n"), "CSSFontFaceRule did not materialize correctly");
        assert(pageRule instanceof CSSPageRule && pageRule.selectorText === ":left", "CSSPageRule did not materialize correctly");
        assert(counterStyleRule instanceof CSSCounterStyleRule && counterStyleRule.type === ruleType("COUNTER_STYLE_RULE", 11), "CSSCounterStyleRule did not materialize correctly");

        assert(supportsRule instanceof CSSSupportsRule, "@supports did not materialize as CSSSupportsRule");
        assert(supportsRule.type === ruleType("SUPPORTS_RULE", 12), "CSSSupportsRule.type mismatch");
        assert(typeof supportsRule.conditionText === "string" && supportsRule.conditionText.length > 0, "CSSSupportsRule.conditionText is unavailable");
        assert(supportsRule.cssRules && supportsRule.cssRules.length === 1, "CSSSupportsRule.cssRules is not a live one-rule list");
        assert(supportsRule.cssRules[0].parentRule === supportsRule && supportsRule.cssRules[0].parentStyleSheet === sheet, "nested support rule parent links are incomplete");
        assert(/@supports\s+\(display:\s*grid\)/.test(supportsRule.cssText), "CSSSupportsRule.cssText lost its condition");

        const nestedBefore = supportsRule.cssRules.length;
        supportsRule.insertRule("#fixture-target { background: rgb(4, 5, 6); }", nestedBefore);
        assert(supportsRule.cssRules.length === nestedBefore + 1, "CSSSupportsRule.insertRule did not update the live CSSRuleList");
        supportsRule.deleteRule(nestedBefore);
        assert(supportsRule.cssRules.length === nestedBefore, "CSSSupportsRule.deleteRule did not update the live CSSRuleList");

        assert(keyframesRule instanceof CSSKeyframesRule, "@keyframes did not materialize as CSSKeyframesRule");
        assert(keyframesRule.type === ruleType("KEYFRAMES_RULE", 7), "CSSKeyframesRule.type mismatch");
        assert(keyframesRule.name === "fixture-pulse", "CSSKeyframesRule.name mismatch");
        assert(keyframesRule.length === 2 && keyframesRule.cssRules.length === 2, "CSSKeyframesRule length/cssRules mismatch");
        assert(keyframesRule[0] instanceof CSSKeyframeRule && keyframesRule[1] instanceof CSSKeyframeRule, "CSSKeyframesRule indexed getter did not return CSSKeyframeRule objects");
        assert(keyframesRule[0].type === ruleType("KEYFRAME_RULE", 8), "CSSKeyframeRule.type mismatch");
        assert(keyframesRule[0].keyText === "0%" && keyframesRule[1].keyText === "100%", "CSSKeyframeRule.keyText was not normalized");
        assert(keyframesRule[0].style && keyframesRule[0].style.opacity === "0", "CSSKeyframeRule.style is unavailable");
        assert(keyframesRule[0].parentRule === keyframesRule && keyframesRule[0].parentStyleSheet === sheet, "CSSKeyframeRule parent links are incomplete");

        keyframesRule.appendRule("50% { opacity: 0.5; }");
        assert(keyframesRule.findRule("50%").keyText === "50%", "CSSKeyframesRule.findRule/appendRule failed");
        const removed = keyframesRule.findRule("from");
        keyframesRule.deleteRule("from");
        assert(!keyframesRule.findRule("0%") && removed.parentRule === null && removed.parentStyleSheet === null, "CSSKeyframesRule.deleteRule did not detach the removed rule");

        return {
          status: "pass",
          observations: {
            namespace: { type: namespaceRule.type, prefix: namespaceRule.prefix, namespaceURI: namespaceRule.namespaceURI, cssText: namespaceRule.cssText },
            fontFace: { type: fontFaceRule.type, cssText: fontFaceRule.cssText },
            page: { type: pageRule.type, selectorText: pageRule.selectorText, cssText: pageRule.cssText },
            counterStyle: { type: counterStyleRule.type, name: counterStyleRule.name, cssText: counterStyleRule.cssText },
            supports: { type: supportsRule.type, conditionText: supportsRule.conditionText, cssText: supportsRule.cssText },
            keyframes: { type: keyframesRule.type, name: keyframesRule.name, remainingRules: keyframesRule.cssRules.length, cssText: keyframesRule.cssText },
          },
        };
      }
      default:
        return { status: "error", reason: `unknown Stylo fixture: ${fixtureName}` };
    }
  } catch (error) {
    return { status: "error", reason: `${error.name || "Error"}: ${error.message || error}` };
  }
}

function sameObservations(left, right) {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
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
          observations[factory.id] = await session.evaluate(`(${evaluateStyloFixture.toString()})(${JSON.stringify(fixtureName)})`, timeoutMs);
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
  const requestedFixtures = options.fixture ? [options.fixture] : styloFixtureNames;
  const fixtureNames = requestedFixtures.filter((name) => availableFixtures.has(name));
  const missingRequested = requestedFixtures.filter((name) => !availableFixtures.has(name));
  if (missingRequested.length) throw new Error(`Missing Stylo fixture(s): ${missingRequested.join(", ")}`);
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
