export {
  compareNormalizedValues,
  normalizeCommandMetadata,
  normalizeErrorValue,
  normalizeJsonValue,
  normalizeStatus,
  serializeNormalizedJson,
  TEST_STATUSES,
} from "./normalize.mjs";

export {
  createAdapterEngine,
  normalizeDifferentialReport,
  normalizeExecutionResult,
  runDifferentialSuite,
  serializeDifferentialReport,
} from "./runner.mjs";
