import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { evaluateRegression } from "../common/regression.mjs";

function summary({ duration = 100, rss = 1000, vms = 2000, throughput = 10, includeRealSite = false } = {}) {
  const groups = [{
    suite: "startup",
    workload: "first-document",
    baseline: "koko-cdp",
    metrics: {
      durationMs: { p95: duration },
      appStartupMs: { p95: 20 },
      rssBytes: { median: rss },
      virtualMemoryPerSessionBytes: { median: vms },
      throughputPagesPerSecond: { median: throughput },
    },
  }];
  if (includeRealSite) groups.push({
    suite: "real-sites",
    workload: "example",
    baseline: "koko-cdp",
    metrics: { durationMs: { p95: 1_000_000 } },
  });
  return { schemaVersion: 1, groups };
}

test("regression helper compares deterministic metrics and excludes real sites", () => {
  const result = evaluateRegression({
    baselineSummary: summary(),
    currentSummary: summary({ duration: 105, rss: 1_050, includeRealSite: true }),
    thresholdPct: 10,
    requireMatch: true,
  });
  assert.equal(result.status, "pass");
  assert.equal(result.comparableGroups, 1);
  assert.equal(result.excludedRealSiteGroups.length, 1);
});

test("regression helper reports a deterministic violation", () => {
  const result = evaluateRegression({
    baselineSummary: summary(),
    currentSummary: summary({ duration: 121 }),
    thresholdPct: 10,
    requireMatch: true,
  });
  assert.equal(result.status, "fail");
  assert.equal(result.violations[0].metric, "durationMs.p95");
  assert.equal(result.violations[0].baselineValue, 100);
  assert.equal(result.violations[0].currentValue, 121);
});

test("standalone gate writes reports and returns a failing exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "koko-regression-test-"));
  try {
    const baselinePath = join(root, "baseline.json");
    const currentPath = join(root, "current.json");
    const outputPath = join(root, "artifact");
    await writeFile(baselinePath, JSON.stringify(summary()));
    await writeFile(currentPath, JSON.stringify(summary({ duration: 125 })));
    const script = fileURLToPath(new URL("../regression-gate.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, "--baseline", baselinePath, "--current", currentPath, "--output", outputPath], { encoding: "utf8" });
    assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /Regression gate: fail/, `${result.stderr}\n${result.stdout}`);
    const report = JSON.parse(await readFile(join(outputPath, "report.json"), "utf8"));
    assert.equal(report.status, "fail");
    assert.match(await readFile(join(outputPath, "report.md"), "utf8"), /durationMs\.p95/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standalone gate returns inconclusive when no deterministic group matches", async () => {
  const result = evaluateRegression({
    baselineSummary: summary(),
    currentSummary: { schemaVersion: 1, groups: [{ suite: "navigation", workload: "new", baseline: "koko-cdp", metrics: {} }] },
    requireMatch: true,
  });
  assert.equal(result.status, "inconclusive");
  assert.equal(result.missingBaselineGroups.length, 1);
});
