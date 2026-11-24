import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdownReport } from "../reports/markdown.mjs";

test("report renders a Koko-only run without a Chromium reference", () => {
  const report = renderMarkdownReport({
    runId: "test-run",
    environment: {
      capturedAt: "2026-01-01T00:00:00.000Z",
      koko: { gitCommit: "abc", gitDirty: false, optimize: "ReleaseFast", buildLabel: "v8-pointer-compression-off" },
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
  assert.match(report, /Koko build label: `v8-pointer-compression-off`/);
  assert.match(report, /\| — \|$/m);
});

test("report renders decomposed cold-start stages", () => {
  const report = renderMarkdownReport({
    runId: "startup-stages",
    environment: {
      capturedAt: "2026-01-01T00:00:00.000Z",
      koko: { gitCommit: "abc", gitDirty: false, optimize: "ReleaseFast", buildLabel: "coordinator" },
      chromium: { version: null },
      benchmarkOptions: { suites: ["startup"] },
    },
    summary: {
      groups: [{
        suite: "startup",
        workload: "first-document",
        baseline: "koko-cdp",
        attempts: 2,
        successes: 2,
        metrics: {
          durationMs: { p50: 100, p95: 110 },
          processReadyMs: { median: 20, p50: 20 },
          appStartupMs: { median: 8, p50: 8 },
          firstSessionMs: { median: 35, p50: 35 },
          firstSessionConnectMs: { median: 1, p50: 1 },
          firstSessionContextMs: { median: 10, p50: 10 },
          firstSessionTargetMs: { median: 15, p50: 15 },
          firstSessionAttachMs: { median: 2, p50: 2 },
          firstSessionDomainsMs: { median: 7, p50: 7 },
          firstNavigationMs: { median: 25, p50: 25 },
        },
      }],
    },
  });
  assert.match(report, /## Cold-start attribution/);
  assert.match(report, /first-document \| koko-cdp \| 110\.00 \| 20\.00 \| 8\.00/);
  assert.match(report, /\| Connect p50 ms \| Context p50 ms \| Target p50 ms/);
});
