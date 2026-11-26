import assert from "node:assert/strict";
import test from "node:test";
import {
  compareNormalizedValues,
  createAdapterEngine,
  normalizeCommandMetadata,
  normalizeJsonValue,
  runDifferentialSuite,
  serializeDifferentialReport,
  serializeNormalizedJson,
} from "../differential/index.mjs";

function fakeEngine(id, execute, extra = {}) {
  return {
    id,
    label: id[0].toUpperCase() + id.slice(1),
    command: { executable: "fake-browser", args: [id, "--deterministic"], cwd: "/workspace" },
    execute,
    ...extra,
  };
}

test("normalization is JSON-safe, sorted, and opt-in for volatile fields", () => {
  const value = normalizeJsonValue({
    z: 2,
    a: { timestamp: 1_700_000_000_000, stable: "kept" },
    nan: Number.NaN,
    missing: undefined,
  }, { volatilePaths: ["$.a.timestamp"] });
  assert.deepEqual(Object.keys(value), ["a", "missing", "nan", "z"]);
  assert.deepEqual(value.a.timestamp, { $normalized: "volatile" });
  assert.deepEqual(value.nan, { $type: "number", value: "NaN" });
  assert.deepEqual(value.missing, { $type: "undefined" });
  assert.match(serializeNormalizedJson({ b: 1, a: 2 }), /"a": 2[\s\S]*"b": 1/);
});

test("comparison uses explicit numeric tolerance without hiding other differences", () => {
  assert.equal(compareNormalizedValues({ value: 10 }, { value: 10.001 }, { floatTolerance: { absolute: 0.01 } }).equal, true);
  assert.equal(compareNormalizedValues({ value: 10 }, { value: 10.1 }, { floatTolerance: { absolute: 0.01 } }).equal, false);
});

test("command metadata is stable and shell-reproducible", () => {
  const command = normalizeCommandMetadata({
    executable: "/opt/Fake Browser",
    args: ["--test", "a value"],
    cwd: "/tmp/koko",
    env: { Z_LAST: 2, A_FIRST: 1 },
  });
  assert.deepEqual(command.env, { A_FIRST: "1", Z_LAST: "2" });
  assert.equal(command.commandLine, "'/opt/Fake Browser' --test 'a value'");
});

test("equivalent engines pass with test-level and subtest-level results", async () => {
  const report = await runDifferentialSuite({
    suite: { id: "basic", category: "WEBIDL" },
    normalization: { volatilePaths: ["$.timestamp"] },
    engines: [
      fakeEngine("chromium", async () => ({
        actual: { value: 42, timestamp: 1 },
        subtests: [{ id: "return", status: "PASS", actual: { answer: 42 } }],
      })),
      fakeEngine("koko", async () => ({
        actual: { timestamp: 2, value: 42 },
        subtests: [{ id: "return", status: "pass", actual: { answer: 42 } }],
      })),
    ],
    tests: [{ id: "result", name: "result", source: { file: "fixture.js", line: 1 } }],
  });
  assert.equal(report.results[0].status, "PASS");
  assert.equal(report.results[0].comparison.equal, true);
  assert.equal(report.results[0].engines[1].subtests[0].status, "PASS");
  assert.equal(report.summary.counts.PASS, 1);
  assert.match(serializeDifferentialReport(report), /koko/);
});

test("behavior mismatches fail and include a command for reproduction", async () => {
  const report = await runDifferentialSuite({
    engines: [
      fakeEngine("chromium", async () => ({ status: "PASS", actual: { value: 1 } })),
      fakeEngine("koko", async () => ({ status: "PASS", actual: { value: 2 } })),
    ],
    tests: [{ id: "different-value", name: "different value" }],
  });
  const result = report.results[0];
  assert.equal(result.status, "FAIL");
  assert.equal(result.comparison.mismatches[0].engine, "koko");
  assert.equal(result.command.commandLine, "fake-browser koko --deterministic");
  assert.equal(report.summary.counts.FAIL, 1);
});

test("expected failures are distinct from unexpected failures", async () => {
  const report = await runDifferentialSuite({
    engines: [fakeEngine("koko", async () => ({ status: "FAIL", reason: "known binding gap" }))],
    tests: [{ id: "known-gap", expectedFail: { koko: true } }],
  });
  assert.equal(report.results[0].status, "EXPECTED_FAIL");
  assert.equal(report.results[0].engines[0].status, "EXPECTED_FAIL");
  assert.equal(report.summary.counts.EXPECTED_FAIL, 1);
  assert.equal(report.summary.failing, 0);
});

test("timeout, crash, harness errors, unsupported, skip, and not-run stay distinct", async () => {
  const never = () => new Promise(() => {});
  const cases = [
    ["timeout", () => never(), "TIMEOUT"],
    ["crash", async () => { const error = new Error("process exited"); error.crash = true; throw error; }, "CRASH"],
    ["harness", async () => { throw new Error("adapter failed"); }, "HARNESS_ERROR"],
    ["unsupported", async () => ({ status: "UNSUPPORTED", reason: "no context" }), "UNSUPPORTED"],
    ["skip", async () => ({ status: "SKIP", reason: "filtered" }), "SKIP"],
  ];
  const report = await runDifferentialSuite({
    timeoutMs: 10,
    engines: [fakeEngine("fake", async ({ test: definition }) => cases.find(([id]) => id === definition.id)[1]())],
    tests: cases.map(([id]) => ({ id })),
  });
  assert.deepEqual(report.results.map((result) => result.status), cases.map(([, , status]) => status));
  const cancelled = new AbortController();
  cancelled.abort();
  const notRun = await runDifferentialSuite({
    signal: cancelled.signal,
    engines: [fakeEngine("fake", async () => ({ status: "PASS" }))],
    tests: [{ id: "cancelled" }],
  });
  assert.equal(notRun.results[0].status, "NOT_RUN");
  assert.equal(notRun.summary.counts.NOT_RUN, 1);
});

test("engine lifecycle is released after execution, including timeout", async () => {
  const events = [];
  const report = await runDifferentialSuite({
    timeoutMs: 10,
    engines: [fakeEngine("fake", async () => new Promise(() => {}), {
      async start() { events.push("start"); return { token: 1 }; },
      async stop({ runtime }) { events.push(`stop:${runtime.token}`); },
    })],
    tests: [{ id: "hang" }],
  });
  assert.equal(report.results[0].status, "TIMEOUT");
  assert.deepEqual(events, ["start", "stop:1"]);
});

test("adapter engines are injectable without importing a browser", async () => {
  const events = [];
  const engine = createAdapterEngine({
    id: "fake-adapter",
    createAdapter: () => ({
      async launch() { events.push("launch"); },
      async close() { events.push("close"); },
    }),
    execute: async ({ runtime }) => ({ status: runtime ? "PASS" : "FAIL", actual: { browser: false } }),
  });
  const report = await runDifferentialSuite({ engines: [engine], tests: [{ id: "injected" }] });
  assert.equal(report.results[0].status, "PASS");
  assert.deepEqual(events, ["launch", "close"]);
});
