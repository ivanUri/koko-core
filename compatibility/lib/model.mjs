export const API_STATUSES = Object.freeze([
  "IMPLEMENTED_VERIFIED",
  "IMPLEMENTED_UNVERIFIED",
  "PARTIAL",
  "MISSING",
  "STUB",
  "INCORRECT",
  "UNSUPPORTED_BY_DESIGN",
  "NOT_APPLICABLE",
  "UNKNOWN",
]);

export const TEST_STATUSES = Object.freeze([
  "PASS",
  "FAIL",
  "TIMEOUT",
  "CRASH",
  "SKIP",
  "EXPECTED_FAIL",
  "UNSUPPORTED",
  "NOT_RUN",
  "HARNESS_ERROR",
]);

export const CATEGORIES = Object.freeze([
  "DOM", "HTML", "CSSOM", "CSS", "LAYOUT", "FETCH", "STREAMS", "EVENTS",
  "WORKERS", "STORAGE", "ENCODING", "CRYPTO", "CANVAS", "WEB_AUDIO",
  "WEBGL", "WEBGPU", "WEBRTC", "MEDIA", "NAVIGATION", "WEBIDL", "OTHER",
]);

export function stableId(parts) {
  return parts.filter((part) => part != null && String(part).length > 0).map(String).join("/");
}

export function sourceRef(file, line = null, column = null) {
  return { file, ...(line == null ? {} : { line }), ...(column == null ? {} : { column }) };
}

export function assertEnum(value, allowed, label) {
  if (!allowed.includes(value)) throw new Error(`${label} must be one of ${allowed.join(", ")}; got ${value}`);
  return value;
}

export function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
}

export function stableJson(value) {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

export function makeTestResult({ id, status, engine = null, durationMs = null, subtests = [], error = null, command = null, metadata = {} }) {
  assertEnum(status, TEST_STATUSES, "test result status");
  return {
    id,
    status,
    engine,
    durationMs,
    subtests: subtests.map((subtest) => ({ ...subtest, status: assertEnum(subtest.status, TEST_STATUSES, "subtest status") })),
    error,
    command,
    metadata,
  };
}

export function emptyCompatibilityReport(metadata = {}) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    metadata,
    scope: { contexts: [], categories: [], sources: [] },
    metrics: {},
    apis: [],
    tests: [],
    tasks: [],
  };
}

export function countBy(items, field) {
  return Object.fromEntries([...new Set(items.map((item) => item[field]).filter(Boolean))].sort().map((value) => [
    value,
    items.filter((item) => item[field] === value).length,
  ]));
}
