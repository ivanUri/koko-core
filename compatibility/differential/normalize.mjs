import { TEST_STATUSES, stableJson } from "../lib/model.mjs";

export { TEST_STATUSES };

const STATUS_ALIASES = new Map([
  ["PASS", "PASS"],
  ["PASSED", "PASS"],
  ["FAIL", "FAIL"],
  ["FAILED", "FAIL"],
  ["TIMEOUT", "TIMEOUT"],
  ["TIMED_OUT", "TIMEOUT"],
  ["CRASH", "CRASH"],
  ["SKIP", "SKIP"],
  ["SKIPPED", "SKIP"],
  ["EXPECTED_FAIL", "EXPECTED_FAIL"],
  ["EXPECTED-FAIL", "EXPECTED_FAIL"],
  ["UNSUPPORTED", "UNSUPPORTED"],
  ["NOT_RUN", "NOT_RUN"],
  ["NOT-RUN", "NOT_RUN"],
  ["HARNESS_ERROR", "HARNESS_ERROR"],
  ["HARNESS-ERROR", "HARNESS_ERROR"],
  ["ERROR", "HARNESS_ERROR"],
]);

const VOLATILE = Object.freeze({ $normalized: "volatile" });

function pathText(path) {
  return path.length === 0 ? "$" : `$.${path.join(".")}`;
}

function matchesPath(path, patterns) {
  const value = pathText(path);
  return patterns.some((pattern) => {
    if (pattern instanceof RegExp) return pattern.test(value);
    const text = String(pattern);
    if (text === value) return true;
    const escaped = text.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*");
    return new RegExp(`^${escaped}$`).test(value);
  });
}

function normalizeError(error, path, options, seen) {
  if (error == null) return null;
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: String(error.message || error),
      ...(error.code == null ? {} : { code: normalizeJsonValue(error.code, options, path.concat("code"), seen) }),
    };
  }
  return normalizeJsonValue(error, options, path, seen);
}

function normalizeObject(value, options, path, seen) {
  if (seen.has(value)) return { $ref: seen.get(value) };
  seen.set(value, pathText(path));

  if (value instanceof Date) {
    return { $type: "date", value: Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString() };
  }
  if (value instanceof RegExp) return { $type: "regexp", source: value.source, flags: value.flags };
  if (value instanceof Error) return normalizeError(value, path, options, seen);
  if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(([key, entry]) => [
        normalizeJsonValue(key, options, path.concat("<key>"), seen),
        normalizeJsonValue(entry, options, path.concat("<value>"), seen),
      ])
      .sort(([left], [right]) => stableJson(left).localeCompare(stableJson(right)));
    return { $type: "map", entries };
  }
  if (value instanceof Set) {
    const entries = [...value].map((entry) => normalizeJsonValue(entry, options, path.concat("<value>"), seen));
    entries.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
    return { $type: "set", entries };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      $type: value.constructor.name,
      values: value instanceof DataView
        ? [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)]
          .map((entry, index) => normalizeJsonValue(entry, options, path.concat(String(index)), seen))
        : [...value].map((entry, index) => normalizeJsonValue(entry, options, path.concat(String(index)), seen)),
    };
  }
  if (value instanceof ArrayBuffer) {
    return { $type: "ArrayBuffer", byteLength: value.byteLength };
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeJsonValue(entry, options, path.concat(String(index)), seen));
  }

  const output = {};
  for (const key of Object.keys(value).sort()) {
    const childPath = path.concat(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    output[key] = descriptor?.get
      ? { $type: "getter", name: descriptor.get.name || null }
      : normalizeJsonValue(value[key], options, childPath, seen);
  }
  return output;
}

/**
 * Convert an executor value to JSON-safe, deterministic data.
 *
 * `volatilePaths` is intentionally opt-in. It is suitable for timestamps or
 * generated ids that the fixture declares nondeterministic; values not listed
 * there remain observable compatibility data and are compared normally.
 */
export function normalizeJsonValue(value, options = {}, path = [], seen = new WeakMap()) {
  const volatilePaths = options.volatilePaths ?? [];
  if (matchesPath(path, volatilePaths)) return { ...VOLATILE };
  if (value === null) return null;
  if (value === undefined) return { $type: "undefined" };
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isNaN(value)) return { $type: "number", value: "NaN" };
    if (value === Infinity) return { $type: "number", value: "Infinity" };
    if (value === -Infinity) return { $type: "number", value: "-Infinity" };
    if (Object.is(value, -0)) return { $type: "number", value: "-0" };
    return value;
  }
  if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
  if (typeof value === "symbol") return { $type: "symbol", value: String(value) };
  if (typeof value === "function") return { $type: "function", name: value.name || null, length: value.length };
  return normalizeObject(value, options, path, seen);
}

export function normalizeStatus(status) {
  if (status == null) return null;
  const normalized = STATUS_ALIASES.get(String(status).trim().toUpperCase().replaceAll(" ", "_"));
  if (!normalized) throw new Error(`Unknown differential result status: ${status}`);
  return normalized;
}

function normalizeCommandPart(value) {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  return String(value);
}

function shellQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

/** Return stable command metadata suitable for copying into a bug report. */
export function normalizeCommandMetadata(command, defaults = {}) {
  const input = typeof command === "string"
    ? { executable: command }
    : Array.isArray(command)
      ? { executable: command[0] ?? null, args: command.slice(1) }
      : command ?? {};
  const executable = normalizeCommandPart(input.executable ?? defaults.executable ?? input.command ?? null);
  const rawArgs = input.args ?? defaults.args ?? [];
  const args = Array.isArray(rawArgs) ? normalizeCommandPart(rawArgs) : [String(rawArgs)];
  const cwd = normalizeCommandPart(input.cwd ?? defaults.cwd ?? null);
  const envInput = input.env ?? defaults.env ?? null;
  const env = envInput && typeof envInput === "object"
    ? Object.fromEntries(Object.keys(envInput).sort().map((key) => [key, String(envInput[key])]))
    : null;
  const argv = executable == null ? args : [executable, ...(args ?? [])];
  return {
    executable,
    args: args ?? [],
    cwd,
    env,
    commandLine: argv.length === 0 ? null : argv.map(shellQuote).join(" "),
  };
}

function compareValues(expected, actual, options, path = []) {
  if (typeof expected === "number" && typeof actual === "number") {
    const absolute = options.floatTolerance?.absolute ?? 0;
    const relative = options.floatTolerance?.relative ?? 0;
    const difference = Math.abs(expected - actual);
    const limit = Math.max(absolute, relative * Math.max(Math.abs(expected), Math.abs(actual)));
    if (difference <= limit) return [];
  }
  if (Object.is(expected, actual)) return [];
  if (typeof expected !== typeof actual || expected == null || actual == null) {
    return [{ path: pathText(path), expected, actual, reason: "value differs" }];
  }
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
      return [{ path: pathText(path), expected, actual, reason: "array differs" }];
    }
    return expected.flatMap((entry, index) => compareValues(entry, actual[index], options, path.concat(String(index))));
  }
  if (typeof expected === "object") {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    return keys.flatMap((key) => {
      if (!(key in expected) || !(key in actual)) {
        return [{ path: pathText(path.concat(key)), expected: expected[key], actual: actual[key], reason: "key differs" }];
      }
      return compareValues(expected[key], actual[key], options, path.concat(key));
    });
  }
  return [{ path: pathText(path), expected, actual, reason: "value differs" }];
}

export function compareNormalizedValues(expected, actual, options = {}) {
  const mismatches = compareValues(expected, actual, options);
  return { equal: mismatches.length === 0, mismatches };
}

export function normalizeErrorValue(error, options = {}) {
  return normalizeError(error, [], options, new WeakMap());
}

export function serializeNormalizedJson(value, options = {}) {
  return stableJson(normalizeJsonValue(value, options));
}
