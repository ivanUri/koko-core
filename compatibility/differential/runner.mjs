import { TEST_STATUSES } from "../lib/model.mjs";
import {
  compareNormalizedValues,
  normalizeCommandMetadata,
  normalizeErrorValue,
  normalizeJsonValue,
  normalizeStatus,
} from "./normalize.mjs";

const TERMINAL_FAILURES = new Set(["FAIL", "TIMEOUT", "CRASH", "HARNESS_ERROR"]);
const STATUS_PRIORITY = new Map([
  ["HARNESS_ERROR", 90],
  ["CRASH", 80],
  ["TIMEOUT", 70],
  ["FAIL", 60],
  ["EXPECTED_FAIL", 50],
  ["UNSUPPORTED", 40],
  ["SKIP", 30],
  ["NOT_RUN", 20],
  ["PASS", 10],
]);

const REPORT_SCHEMA = "koko.compatibility.differential.v1";

function errorText(error) {
  return error instanceof Error ? `${error.name || "Error"}: ${error.message}` : String(error);
}

function isAbortError(error) {
  return error?.name === "AbortError" || error?.code === "ABORT_ERR";
}

function statusOf(value) {
  return normalizeStatus(value);
}

function worstStatus(statuses, fallback = "PASS") {
  return statuses.reduce((worst, status) =>
    (STATUS_PRIORITY.get(status) ?? -1) > (STATUS_PRIORITY.get(worst) ?? -1) ? status : worst, fallback);
}

function expectedFailureFor(expectedFail, engineId) {
  if (expectedFail === true) return true;
  if (Array.isArray(expectedFail)) return expectedFail.includes(engineId);
  if (expectedFail && typeof expectedFail === "object") return expectedFail[engineId] === true;
  return false;
}

function applyExpectedFailure(status, expectedFail) {
  return expectedFail && TERMINAL_FAILURES.has(status) ? "EXPECTED_FAIL" : status;
}

function normalizeSubtest(raw, index, options, expectedFail) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { actual: raw };
  let status = statusOf(input.status) ?? (input.error ? "FAIL" : "PASS");
  status = applyExpectedFailure(status, expectedFail || input.expectedFail === true);
  return {
    id: String(input.id ?? input.name ?? `subtest-${index + 1}`),
    ...(input.name == null ? {} : { name: String(input.name) }),
    status,
    ...(input.actual === undefined && input.value === undefined && input.result === undefined
      ? {}
      : { actual: normalizeJsonValue(input.actual ?? input.value ?? input.result, options) }),
    ...(input.expected === undefined ? {} : { expected: normalizeJsonValue(input.expected, options) }),
    ...(input.error == null ? {} : { error: normalizeErrorValue(input.error, options) }),
    ...(input.reason == null ? {} : { reason: String(input.reason) }),
    ...(input.durationMs == null ? {} : { durationMs: Number(input.durationMs) }),
    ...(input.metadata == null ? {} : { metadata: normalizeJsonValue(input.metadata, options) }),
  };
}

function deriveTestStatus(explicit, subtests) {
  const subtestStatus = subtests.length === 0 ? null : worstStatus(subtests.map((subtest) => subtest.status));
  if (explicit == null) return subtestStatus ?? "PASS";
  return subtestStatus == null ? explicit : worstStatus([explicit, subtestStatus]);
}

/** Normalize one executor response while preserving test and subtest outcomes. */
export function normalizeExecutionResult(raw, {
  options = {},
  expectedFail = false,
  durationMs = null,
} = {}) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : { actual: raw };
  let status = statusOf(input.status) ?? (input.error ? "FAIL" : null);
  const subtests = Array.isArray(input.subtests)
    ? input.subtests.map((subtest, index) => normalizeSubtest(subtest, index, options, expectedFail))
    : [];
  status = deriveTestStatus(status, subtests);
  status = applyExpectedFailure(status, expectedFail || input.expectedFail === true);
  const actual = input.actual ?? input.value ?? input.result;
  return {
    status,
    ...(actual === undefined ? {} : { actual: normalizeJsonValue(actual, options) }),
    ...(input.expected === undefined ? {} : { expected: normalizeJsonValue(input.expected, options) }),
    subtests,
    ...(input.error == null ? {} : { error: normalizeErrorValue(input.error, options) }),
    ...(input.reason == null ? {} : { reason: String(input.reason) }),
    ...(durationMs == null ? {} : { durationMs }),
    ...(input.metadata == null ? {} : { metadata: normalizeJsonValue(input.metadata, options) }),
  };
}

function compareSubtests(reference, candidate, options) {
  const referenceById = new Map(reference.map((subtest) => [subtest.id, subtest]));
  const candidateById = new Map(candidate.map((subtest) => [subtest.id, subtest]));
  const ids = [...new Set([...referenceById.keys(), ...candidateById.keys()])].sort();
  const mismatches = [];
  for (const id of ids) {
    const expected = referenceById.get(id);
    const actual = candidateById.get(id);
    if (!expected || !actual) {
      mismatches.push({ path: `$.subtests[${JSON.stringify(id)}]`, expected, actual, reason: "subtest presence differs" });
      continue;
    }
    if (expected.status !== actual.status) {
      mismatches.push({ path: `$.subtests[${JSON.stringify(id)}].status`, expected: expected.status, actual: actual.status, reason: "subtest status differs" });
    }
    if (expected.actual !== undefined || actual.actual !== undefined) {
      mismatches.push(...compareNormalizedValues(expected.actual, actual.actual, options).mismatches.map((mismatch) => ({
        ...mismatch,
        path: `$.subtests[${JSON.stringify(id)}]${mismatch.path.slice(1)}`,
      })));
    }
  }
  return mismatches;
}

function compareExecutionResults(reference, candidate, options) {
  if (reference.status !== candidate.status) {
    return {
      equal: false,
      mismatches: [{ path: "$.status", expected: reference.status, actual: candidate.status, reason: "test status differs" }],
    };
  }
  if (reference.status !== "PASS") return { equal: true, mismatches: [] };
  const mismatches = [];
  if (reference.actual !== undefined || candidate.actual !== undefined) {
    mismatches.push(...compareNormalizedValues(reference.actual, candidate.actual, options).mismatches);
  }
  mismatches.push(...compareSubtests(reference.subtests, candidate.subtests, options));
  return { equal: mismatches.length === 0, mismatches };
}

function commandFor({ test, engine, options }) {
  let command = test.command ?? engine.command ?? options.command;
  if (typeof command === "function") command = command({ test, engine });
  const defaults = {
    executable: options.commandExecutable ?? process.execPath,
    args: ["compatibility/differential/runner.mjs", "--test-id", test.id, "--engine", engine.id],
    cwd: options.cwd ?? process.cwd(),
  };
  return normalizeCommandMetadata(command, defaults);
}

function resultForNotRun(test, engine, options, reason) {
  return {
    id: test.id,
    name: test.name ?? test.id,
    engine: { id: engine.id, ...(engine.label == null ? {} : { label: engine.label }) },
    status: "NOT_RUN",
    subtests: [],
    reason,
    command: commandFor({ test, engine, options }),
  };
}

function resultNeedsCommand(status) {
  return status !== "PASS";
}

function normalizeEngine(engine, index) {
  if (!engine || typeof engine !== "object") throw new TypeError(`engine[${index}] must be an object`);
  if (!engine.id) throw new TypeError(`engine[${index}] is missing id`);
  if (typeof engine.execute !== "function") throw new TypeError(`engine ${engine.id} is missing execute()`);
  return { ...engine, id: String(engine.id) };
}

/**
 * Adapt an existing Playwright/CDP-style adapter without coupling this runner
 * to either implementation. `execute` owns the adapter-specific session work;
 * the returned engine owns launch and close exactly once per suite.
 */
export function createAdapterEngine({ id, label = null, createAdapter, execute, command = null } = {}) {
  if (!id) throw new TypeError("adapter engine is missing id");
  if (typeof createAdapter !== "function") throw new TypeError(`adapter engine ${id} is missing createAdapter()`);
  if (typeof execute !== "function") throw new TypeError(`adapter engine ${id} is missing execute()`);
  return {
    id: String(id),
    ...(label == null ? {} : { label }),
    ...(command == null ? {} : { command }),
    async start() {
      const adapter = await createAdapter();
      await adapter.launch?.();
      return adapter;
    },
    execute,
    async stop({ runtime }) {
      await runtime?.close?.();
    },
  };
}

async function runWithTimeout(task, { timeoutMs, signal }) {
  const controller = new AbortController();
  let timer = null;
  let removeAbort = () => {};
  const work = Promise.resolve().then(() => task(controller.signal));
  // A timed-out executor may still be unwinding. Observe it so a late rejection
  // cannot become an unhandled rejection after the test has been classified.
  work.catch(() => {});
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error(`Timed out after ${timeoutMs} ms`));
      resolve({ timedOut: true });
    }, timeoutMs);
  });
  const aborted = signal ? new Promise((resolve) => {
    if (signal.aborted) return resolve({ aborted: true });
    const listener = () => resolve({ aborted: true });
    signal.addEventListener("abort", listener, { once: true });
    removeAbort = () => signal.removeEventListener("abort", listener);
  }) : null;
  try {
    const winner = await Promise.race([work.then((value) => ({ value })), timeout, ...(aborted ? [aborted] : [])]);
    if (winner.timedOut || winner.aborted) {
      controller.abort(winner.timedOut ? new Error("timeout") : signal.reason);
      return winner;
    }
    return winner.value;
  } finally {
    clearTimeout(timer);
    removeAbort();
  }
}

async function executeEngine(engine, test, options, runtime, signal) {
  const started = performance.now();
  const expectedFail = expectedFailureFor(test.expectedFail, engine.id);
  try {
    const raw = await runWithTimeout(
      (executionSignal) => engine.execute({ test, engine, runtime, signal: executionSignal, timeoutMs: options.timeoutMs }),
      { timeoutMs: options.timeoutMs, signal },
    );
    if (raw?.timedOut) {
      return normalizeExecutionResult({ status: "TIMEOUT", reason: `Timed out after ${options.timeoutMs} ms` }, { options: options.normalization, expectedFail, durationMs: performance.now() - started });
    }
    if (raw?.aborted) {
      return normalizeExecutionResult({ status: "NOT_RUN", reason: "Run cancelled" }, { options: options.normalization, durationMs: performance.now() - started });
    }
    return normalizeExecutionResult(raw, { options: options.normalization, expectedFail, durationMs: performance.now() - started });
  } catch (error) {
    const status = error?.status ? statusOf(error.status) : error?.crash || error?.code === "CRASH" ? "CRASH" : isAbortError(error) && signal?.aborted ? "NOT_RUN" : "HARNESS_ERROR";
    return normalizeExecutionResult({ status, error, reason: errorText(error) }, {
      options: options.normalization,
      expectedFail,
      durationMs: performance.now() - started,
    });
  }
}

function summarize(results) {
  const counts = Object.fromEntries(TEST_STATUSES.map((status) => [status, 0]));
  for (const result of results) counts[result.status] += 1;
  return {
    tests: results.length,
    executed: results.filter((result) => !["NOT_RUN", "SKIP", "UNSUPPORTED"].includes(result.status)).length,
    passing: counts.PASS,
    failing: counts.FAIL + counts.TIMEOUT + counts.CRASH + counts.HARNESS_ERROR,
    counts,
  };
}

/**
 * Run the same test definitions through injectable Chromium/Koko executors.
 * An engine may additionally implement start({ signal }) and stop({ runtime }),
 * which lets callers wrap the repository's Playwright or CDP adapters without
 * making this package import or launch a browser on its own.
 */
export async function runDifferentialSuite({
  tests,
  engines,
  suite = {},
  timeoutMs = 30_000,
  normalization = {},
  referenceEngine = null,
  command = null,
  commandExecutable = null,
  cwd = process.cwd(),
  signal = null,
} = {}) {
  if (!Array.isArray(tests)) throw new TypeError("tests must be an array");
  const normalizedEngines = (engines ?? []).map(normalizeEngine);
  if (normalizedEngines.length === 0) throw new TypeError("at least one engine is required");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be a positive number");
  const options = { timeoutMs, normalization, command, commandExecutable, cwd };
  const runtimes = new Map();
  const startupErrors = new Map();
  try {
    for (const engine of normalizedEngines) {
      if (typeof engine.start !== "function") continue;
      try {
        runtimes.set(engine.id, await engine.start({ engine, signal, timeoutMs }));
      } catch (error) {
        startupErrors.set(engine.id, error);
      }
    }

    const results = [];
    for (const test of tests) {
      if (!test?.id) throw new TypeError("every test must have an id");
      const engineResults = [];
      for (const engine of normalizedEngines) {
        if (signal?.aborted) {
          engineResults.push(resultForNotRun(test, engine, options, "Run cancelled before execution"));
          continue;
        }
        let execution;
        if (startupErrors.has(engine.id)) {
          const error = startupErrors.get(engine.id);
          execution = normalizeExecutionResult({ status: "HARNESS_ERROR", error, reason: `Engine setup failed: ${errorText(error)}` }, {
            options: normalization,
            expectedFail: expectedFailureFor(test.expectedFail, engine.id),
          });
        } else {
          execution = await executeEngine(engine, test, options, runtimes.get(engine.id), signal);
        }
        const entry = {
          id: test.id,
          name: test.name ?? test.id,
          engine: { id: engine.id, ...(engine.label == null ? {} : { label: engine.label }) },
          ...execution,
        };
        if (resultNeedsCommand(execution.status)) entry.command = commandFor({ test, engine, options });
        engineResults.push(entry);
      }

      const referenceId = referenceEngine ?? normalizedEngines[0].id;
      const reference = engineResults.find((result) => result.engine.id === referenceId) ?? engineResults[0];
      const mismatches = [];
      for (const candidate of engineResults) {
        if (candidate === reference) continue;
        const comparison = compareExecutionResults(reference, candidate, normalization);
        if (!comparison.equal) mismatches.push({ engine: candidate.engine.id, ...comparison });
      }
      const executionStatuses = engineResults.map((result) => result.status);
      let status = worstStatus(executionStatuses);
      if (mismatches.length > 0) {
        const expected = test.expectedFail === true || normalizedEngines.some((engine) => expectedFailureFor(test.expectedFail, engine.id));
        status = expected ? "EXPECTED_FAIL" : "FAIL";
      }
      const result = {
        id: test.id,
        name: test.name ?? test.id,
        ...(test.source == null ? {} : { source: normalizeJsonValue(test.source, normalization) }),
        status,
        engines: engineResults,
        comparison: {
          referenceEngine: reference.engine.id,
          equal: mismatches.length === 0,
          mismatches,
        },
      };
      if (resultNeedsCommand(status)) {
        const commandEngine = mismatches[0]?.engine
          ? engineResults.find((entry) => entry.engine.id === mismatches[0].engine)?.engine
          : engineResults.find((entry) => entry.status !== "PASS")?.engine ?? reference.engine;
        const engine = normalizedEngines.find((entry) => entry.id === commandEngine.id) ?? normalizedEngines[0];
        result.command = commandFor({ test, engine, options });
      }
      results.push(result);
    }
    return {
      schemaVersion: REPORT_SCHEMA,
      suite: normalizeJsonValue(suite, normalization),
      engines: normalizedEngines.map((engine) => ({ id: engine.id, ...(engine.label == null ? {} : { label: engine.label }) })),
      results,
      summary: summarize(results),
    };
  } finally {
    for (const engine of [...normalizedEngines].reverse()) {
      if (!runtimes.has(engine.id) || typeof engine.stop !== "function") continue;
      await Promise.resolve(engine.stop({ engine, runtime: runtimes.get(engine.id) })).catch(() => {});
    }
  }
}

export function normalizeDifferentialReport(report, options = {}) {
  return normalizeJsonValue(report, options);
}

export function serializeDifferentialReport(report, options = {}) {
  return `${JSON.stringify(normalizeDifferentialReport(report, options), null, 2)}\n`;
}
