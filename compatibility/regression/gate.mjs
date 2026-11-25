import { readJson } from "../lib/io.mjs";

export function evaluateGate(baseline, current) {
  const baselineById = new Map((baseline.apis ?? []).map((api) => [api.id, api]));
  const regressions = [];
  for (const api of current.apis ?? []) {
    const previous = baselineById.get(api.id);
    if (previous && previous.status === "IMPLEMENTED_VERIFIED" && api.status !== previous.status) regressions.push({ id: api.id, from: previous.status, to: api.status });
  }
  const baselineTests = new Map((baseline.tests ?? []).map((test) => [test.id, test]));
  for (const test of current.tests ?? []) {
    const previous = baselineTests.get(test.id);
    if (previous?.status === "PASS" && test.status !== "PASS") regressions.push({ id: test.id, from: previous.status, to: test.status });
  }
  return { pass: regressions.length === 0, regressions };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = evaluateGate(await readJson(process.argv[2]), await readJson(process.argv[3]));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.pass) process.exitCode = 1;
}
