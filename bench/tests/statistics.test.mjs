import assert from "node:assert/strict";
import test from "node:test";
import { describe, summarizeRecords } from "../common/statistics.mjs";

test("describe returns deterministic percentiles", () => {
  const result = describe([5, 1, 3, 2, 4]);
  assert.equal(result.count, 5);
  assert.equal(result.median, 3);
  assert.equal(result.p95, 4.8);
  assert.equal(result.min, 1);
  assert.equal(result.max, 5);
});

test("summary excludes warmups from statistics and retains measured failures", () => {
  const base = { suite: "navigation", workload: "small", baseline: "koko-cdp" };
  const [group] = summarizeRecords([
    { ...base, warmup: true, success: true, metrics: { durationMs: 999 } },
    { ...base, warmup: false, success: true, metrics: { durationMs: 10 } },
    { ...base, warmup: false, success: false, metrics: {} },
  ]);
  assert.equal(group.attempts, 2);
  assert.equal(group.successes, 1);
  assert.equal(group.failures, 1);
  assert.equal(group.successRate, 0.5);
  assert.equal(group.metrics.durationMs.median, 10);
});

