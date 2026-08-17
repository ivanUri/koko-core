import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

function hash(text) {
  let value = 2166136261;
  for (const character of text) {
    value ^= character.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack ?? null,
  };
}

export class RunContext {
  constructor({ runId, rawPath, options, fixtures, realSites = [] }) {
    this.runId = runId;
    this.rawPath = rawPath;
    this.options = options;
    this.fixtures = fixtures;
    this.realSites = realSites;
    this.records = [];
  }

  async initialize() {
    await mkdir(dirname(this.rawPath), { recursive: true });
  }

  ordered(factories, key) {
    if (factories.length < 2) return factories;
    const offset = hash(`${this.runId}:${key}`) % factories.length;
    const rotated = [...factories.slice(offset), ...factories.slice(0, offset)];
    return hash(key) % 2 === 0 ? rotated : rotated.reverse();
  }

  async record({ suite, workload, baseline, iteration, warmup, startedAt, metrics, details, error }) {
    const record = {
      schemaVersion: 1,
      runId: this.runId,
      suite,
      workload,
      baseline,
      iteration,
      warmup,
      startedAt: startedAt ?? new Date().toISOString(),
      success: !error,
      metrics: metrics ?? {},
      ...(details ? { details } : {}),
      ...(error ? { error: serializeError(error) } : {}),
    };
    this.records.push(record);
    await appendFile(this.rawPath, `${JSON.stringify(record)}\n`);
    const status = error ? `FAIL ${error.message}` : "ok";
    process.stdout.write(`  ${suite}/${workload} ${baseline} #${iteration}${warmup ? " warmup" : ""}: ${status}\n`);
    return record;
  }
}
