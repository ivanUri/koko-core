#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateRegression } from "./common/regression.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage() {
  return `Usage: node bench/regression-gate.mjs --baseline <summary.json> --current <summary.json> --output <directory> [options]

Options:
  --threshold-pct <n>  Maximum allowed relative change (default: 10)
  --mode <fail|warn>   Exit 1 on violations in fail mode (default: fail)
  --allow-missing      Do not mark unmatched current groups inconclusive
  --help               Show this help

The gate compares deterministic summary groups only. Groups from the
real-sites suite are reported as excluded and never cause a gate failure.
The output directory receives report.json and report.md; no benchmark run is
performed and no live site is contacted.
`;
}

function parseArgs(argv) {
  const options = { thresholdPct: 10, mode: "fail", requireMatch: true };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`Missing value after ${argument}`);
      return value;
    };
    if (argument === "--baseline") options.baseline = next();
    else if (argument === "--current") options.current = next();
    else if (argument === "--output") options.output = next();
    else if (argument === "--threshold-pct") options.thresholdPct = Number(next());
    else if (argument === "--mode") options.mode = next();
    else if (argument === "--allow-missing") options.requireMatch = false;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (!options.help && (!options.baseline || !options.current || !options.output)) {
    throw new Error("--baseline, --current and --output are required");
  }
  if (!Number.isFinite(options.thresholdPct) || options.thresholdPct < 0) {
    throw new Error("--threshold-pct must be a number >= 0");
  }
  if (!["fail", "warn"].includes(options.mode)) throw new Error("--mode must be fail or warn");
  return options;
}

async function readSummary(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} summary ${path}: ${error.message}`);
  }
}

function markdownReport(result) {
  const status = result.status.toUpperCase();
  const rows = result.violations.map((violation) =>
    `| ${violation.suite} | ${violation.workload} | ${violation.baseline} | ${violation.metric} | ${violation.baselineValue} | ${violation.currentValue} | ${violation.changePct.toFixed(2)}% |`);
  const missing = result.missingBaselineGroups.length === 0
    ? "None"
    : result.missingBaselineGroups.map((group) => `${group.suite}/${group.workload}/${group.baseline}`).join(", ");
  return `# Benchmark Regression Gate

- Status: **${status}**
- Baseline: ${result.against}
- Current: ${result.current}
- Threshold: ${result.thresholdPct}%
- Comparable deterministic groups: ${result.comparableGroups}
- Excluded live-site groups: ${result.excludedRealSiteGroups.length}
- Missing baseline groups: ${missing}

## Violations

| Suite | Workload | Baseline ID | Metric | Previous | Current | Change |
|---|---|---|---|---:|---:|---:|
${rows.length === 0 ? "| — | — | — | None | — | — | — |" : rows.join("\n")}

This report is based on precomputed deterministic summary JSON. It does not
launch Koko, Chromium, or contact live sites.
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  const baselinePath = resolve(projectRoot, options.baseline);
  const currentPath = resolve(projectRoot, options.current);
  const output = resolve(projectRoot, options.output);
  const result = evaluateRegression({
    baselineSummary: await readSummary(baselinePath, "baseline"),
    currentSummary: await readSummary(currentPath, "current"),
    baselinePath,
    currentPath,
    thresholdPct: options.thresholdPct,
    mode: options.mode,
    requireMatch: options.requireMatch,
  });
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, "report.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(resolve(output, "report.md"), markdownReport(result));
  process.stdout.write(`Regression gate: ${result.status}\nJSON: ${resolve(output, "report.json")}\nMarkdown: ${resolve(output, "report.md")}\n`);
  if (result.status === "inconclusive") return 2;
  if (result.status === "fail" && options.mode === "fail") return 1;
  return 0;
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  process.stderr.write(`regression-gate: ${error.stack ?? error.message}\n`);
  process.exitCode = 2;
});
