import assert from "node:assert/strict";
import test from "node:test";
import { createProbeReport, writeProbeReport } from "../common/probe-report.mjs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("probe report is self-describing and writes a reproducible artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "koko-probe-report-"));
  try {
    const report = await createProbeReport({
      probe: "handshake-admission",
      binary: "./zig-out/bin/koko",
      options: { maxPending: 2, attempts: 8 },
      startedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 123,
      pending: 2,
    });
    const output = join(root, "nested", "report.json");
    await writeProbeReport(output, report);
    const parsed = JSON.parse(await readFile(output, "utf8"));
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.probe, "handshake-admission");
    assert.equal(parsed.options.attempts, 8);
    assert.equal(parsed.pending, 2);
    assert.match(parsed.binary.path, /zig-out[\\/]bin[\\/]koko$/);
    assert.ok(parsed.binary.sha256 === null || /^[0-9a-f]{64}$/.test(parsed.binary.sha256));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
