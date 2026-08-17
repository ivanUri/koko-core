import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdownReport } from "../reports/markdown.mjs";

test("report renders a Koko-only run without a Chromium reference", () => {
  const report = renderMarkdownReport({
    runId: "test-run",
    environment: {
      capturedAt: "2026-01-01T00:00:00.000Z",
      koko: { gitCommit: "abc", gitDirty: false, optimize: "ReleaseFast" },
      chromium: { version: null },
      benchmarkOptions: { suites: ["startup"] },
    },
    summary: {
      groups: [{
        suite: "startup",
        workload: "first-document",
        baseline: "koko-cdp",
        attempts: 1,
        successes: 1,
        metrics: { durationMs: { median: 12, p95: 12 } },
      }],
    },
  });
  assert.match(report, /startup \| first-document \| koko-cdp/);
  assert.match(report, /\| — \|$/m);
});
