function percentile(sorted, quantile) {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function describe(values) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / sorted.length;
  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted.at(-1),
    mean,
    median: percentile(sorted, 0.5),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    stddev: Math.sqrt(variance),
  };
}

export function summarizeRecords(records) {
  const groups = new Map();
  for (const record of records.filter((entry) => !entry.warmup)) {
    const key = [record.suite, record.workload, record.baseline].join("\u0000");
    const group = groups.get(key) ?? {
      suite: record.suite,
      workload: record.workload,
      baseline: record.baseline,
      attempts: 0,
      successes: 0,
      failures: 0,
      metrics: {},
    };
    group.attempts += 1;
    if (record.success) {
      group.successes += 1;
      for (const [name, value] of Object.entries(record.metrics ?? {})) {
        if (!Number.isFinite(value)) continue;
        const values = group.metrics[name] ?? [];
        values.push(value);
        group.metrics[name] = values;
      }
    } else {
      group.failures += 1;
    }
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => ({
    ...group,
    successRate: group.attempts === 0 ? 0 : group.successes / group.attempts,
    metrics: Object.fromEntries(
      Object.entries(group.metrics).map(([name, values]) => [name, describe(values)]),
    ),
  }));
}

