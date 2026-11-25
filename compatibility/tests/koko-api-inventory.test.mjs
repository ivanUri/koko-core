import test from "node:test";
import assert from "node:assert/strict";
import { buildKokoInventory, scanKokoSource, scanZigSource } from "../inventory/koko-api-inventory.mjs";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("scans structured JsApi declarations and preserves binding metadata", async () => {
  const source = await fs.readFile(path.join(here, "fixtures/structured-api.zig"), "utf8");
  const inventory = scanZigSource(source, "compatibility/tests/fixtures/structured-api.zig");
  assert.equal(inventory.interfaceCount, 1);
  assert.equal(inventory.memberCount, 6);

  const api = inventory.interfaces[0];
  assert.deepEqual(api.meta, { constructor_alias: "BaseAlias", enumerable: true, name: "Base" });
  assert.equal(api.constructors.length, 1);
  assert.equal(api.constructors[0].binding.arity.value, 1);
  assert.equal(api.constructors[0].binding.arity.source, "zig-signature");

  const members = Object.fromEntries(api.members.map((member) => [member.name, member]));
  assert.equal(members.staticThing.kind, "operation");
  assert.deepEqual(members.staticThing.binding.arity, { value: 2, source: "binding-option" });
  assert.equal(members.staticThing.binding.static, true);
  assert.equal(members.webdriver.signals.wptOnly, true);
  assert.equal(members.renamed.name, "renamed");
  assert.equal(members.renamed.declaredName, "renamed");
  assert.equal(members.renamed.signals.noop, true);
  assert.equal(members.value.binding.getter, "Base.getValue");
  assert.equal(members.value.binding.setter, "Base.setValue");
  assert.equal(members.value.binding.deletable, false);
  assert.equal(members.ANSWER.kind, "constant");
  assert.equal(members.ANSWER.binding.value, 42);
  assert.deepEqual(members.items.binding.targets, [
    "Base.getItem",
    "Base.items",
    "Base.setItem",
    "Base.deleteItem",
  ]);
  assert.deepEqual(members.items.source.start, { line: 17, column: 9 });
});

test("output ordering is deterministic", () => {
  const source = `
const Zed = @This();
pub const JsApi = struct {
  pub const Meta = struct { pub const name = "Zed"; };
  pub const z = bridge.function(Zed.z, .{});
  pub const a = bridge.function(Zed.a, .{});
};
fn z() void {}
fn a() void {}
`;
  const first = scanZigSource(source, "fixture.zig");
  const second = scanZigSource(source, "fixture.zig");
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(first.interfaces[0].members.map((member) => member.name), ["a", "z"]);
});

test("maps bridge registration lists to execution-context exposure", async () => {
  const inventory = await scanKokoSource(path.join(here, "fixtures/repo"));
  assert.deepEqual(inventory.interfaces[0].exposure, ["DedicatedWorker", "SharedWorker", "Window"]);
  assert.deepEqual(inventory.interfaces[0].binding.registrationLists, [
    "PageJsApis",
    "SharedWorkerJsApis",
    "WorkerJsApis",
  ]);
});

test("provides the compatibility CLI inventory envelope", async () => {
  const inventory = await buildKokoInventory({ root: path.join(here, "fixtures/repo") });
  assert.equal(inventory.kind, "koko-inventory");
  assert.equal(inventory.source, "koko");
  assert.equal(inventory.interfaces[0].name, "Example");
  assert.equal(inventory.interfaces[0].constructors.length, 1);
});
