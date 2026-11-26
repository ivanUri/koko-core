import assert from "node:assert/strict";
import test from "node:test";
import { generateBindingCases } from "../webidl/binding-cases.mjs";

test("binding case generation is deterministic and keeps conversion contracts explicit", () => {
  const first = generateBindingCases({ interfaceName: "Event", operationName: "initEvent" });
  const second = generateBindingCases({ interfaceName: "Event", operationName: "initEvent" });
  assert.deepEqual(first, second);
  assert.equal(first.find((probe) => probe.kind === "required-argument").expected.throws, "TypeError");
  assert.equal(first.find((probe) => probe.kind === "integer").expected.value, 1);
  assert.ok(first.some((probe) => probe.kind === "receiver-brand"));
});
