const GROUP_SEPARATOR = "\u0000";

const CHECKS = [
  ["durationMs.p95", "durationMs", "p95", "higher-is-worse"],
  ["appStartupMs.p95", "appStartupMs", "p95", "higher-is-worse"],
  ["rssBytes.median", "rssBytes", "median", "higher-is-worse"],
  ["virtualMemoryPerSessionBytes.median", "virtualMemoryPerSessionBytes", "median", "higher-is-worse"],
  ["throughputPagesPerSecond.median", "throughputPagesPerSecond", "median", "lower-is-worse"],
];

function groupKey(group) {
  return [group.suite, group.workload, group.baseline].join(GROUP_SEPARATOR);
}

function finiteMetric(group, name, statistic) {
  const value = group?.metrics?.[name]?.[statistic];
  return Number.isFinite(value) ? value : null;
}

function validateSummary(summary, label) {
  if (!summary || typeof summary !== "object" || !Array.isArray(summary.groups)) {
    throw new Error(`${label} must be a benchmark summary with a groups array`);
  }
  for (const [index, group] of summary.groups.entries()) {
    if (!group || typeof group !== "object" || typeof group.suite !== "string" ||
      typeof group.workload !== "string" || typeof group.baseline !== "string") {
      throw new Error(`${label}.groups[${index}] has no valid suite/workload/baseline identity`);
    }
  }
}

/**
 * Compare two benchmark summaries. Real-site groups are deliberately excluded
 * from hard-gate comparisons because their inputs are externally mutable.
 *
 * `requireMatch` is false for the in-runner compatibility path. Standalone CI
 * callers should set it to true so a typo or incompatible baseline cannot pass
 * with zero comparable groups.
 */
export function evaluateRegression({
  baselineSummary,
  currentSummary,
  baselinePath = null,
  currentPath = null,
  thresholdPct = 10,
  mode = "fail",
  requireMatch = false,
} = {}) {
  validateSummary(baselineSummary, "baseline summary");
  validateSummary(currentSummary, "current summary");
  if (!Number.isFinite(thresholdPct) || thresholdPct < 0) throw new Error("thresholdPct must be a number >= 0");
  if (!["warn", "fail"].includes(mode)) throw new Error("mode must be warn or fail");

  const baselineGroups = new Map(baselineSummary.groups.map((group) => [groupKey(group), group]));
  const violations = [];
  const comparisons = [];
  const missingBaselineGroups = [];
  const excludedRealSiteGroups = currentSummary.groups.filter((group) => group.suite === "real-sites").map(groupKey);
  const threshold = thresholdPct / 100;

  for (const current of currentSummary.groups) {
    if (current.suite === "real-sites") continue;
    const key = groupKey(current);
    const baseline = baselineGroups.get(key);
    if (!baseline) {
      missingBaselineGroups.push({ suite: current.suite, workload: current.workload, baseline: current.baseline });
      continue;
    }

    const comparison = { suite: current.suite, workload: current.workload, baseline: current.baseline, metrics: [] };
    for (const [metric, name, statistic, direction] of CHECKS) {
      const currentValue = finiteMetric(current, name, statistic);
      const baselineValue = finiteMetric(baseline, name, statistic);
      if (currentValue === null || baselineValue === null || baselineValue === 0) continue;
      const changePct = ((currentValue - baselineValue) / Math.abs(baselineValue)) * 100;
      const regressed = direction === "higher-is-worse"
        ? changePct > thresholdPct
        : changePct < -thresholdPct;
      const result = { metric, currentValue, baselineValue, changePct, direction, regressed };
      comparison.metrics.push(result);
      if (regressed) violations.push({ suite: current.suite, workload: current.workload, baseline: current.baseline, ...result });
    }
    comparisons.push(comparison);
  }

  const comparableGroups = comparisons.length;
  const inconclusive = comparableGroups === 0 || (requireMatch && missingBaselineGroups.length > 0);
  return {
    schemaVersion: 1,
    status: violations.length > 0 ? "fail" : inconclusive ? "inconclusive" : "pass",
    against: baselinePath,
    current: currentPath,
    thresholdPct,
    mode,
    comparableGroups,
    missingBaselineGroups,
    excludedRealSiteGroups,
    comparisons,
    violations,
  };
}

export { CHECKS };
