import assert from "node:assert/strict";
import test from "node:test";
import { processTreeSnapshot } from "../common/process-tree.mjs";

test("process tree sampler reads the current Linux/macOS process", { skip: process.platform === "win32" }, () => {
  const snapshot = processTreeSnapshot(process.pid);
  assert.equal(snapshot.rootPid, process.pid);
  assert.ok(snapshot.processCount >= 1);
  assert.ok(snapshot.rssBytes > 0);
  assert.ok(snapshot.virtualMemoryBytes >= snapshot.rssBytes);
});
