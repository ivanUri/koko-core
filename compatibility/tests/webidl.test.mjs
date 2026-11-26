import assert from "node:assert/strict";
import test from "node:test";
import { buildWebIDLInventory } from "../webidl/inventory.mjs";
import { parseWebIDL } from "../webidl/parser.mjs";

test("WebIDL inventory preserves definitions, overload shape, exposure, and includes", async () => {
  const inventory = await buildWebIDLInventory({ root: "compatibility/fixtures/webidl", source: "fixture", context: "Window" });
  assert.equal(inventory.definitions.find((definition) => definition.name === "EventPhase").kind, "enum");
  assert.equal(inventory.definitions.find((definition) => definition.name === "EventType").kind, "typedef");
  assert.deepEqual(inventory.includes, [{ mixin: "GlobalEventHandlers", target: "EventTarget", source: { file: "core.idl", line: 19 } }]);
  assert.equal(inventory.members.find((member) => member.id === "Event/attribute/bubbles/2").readonly, true);
  assert.equal(inventory.members.find((member) => member.interface === "EventTarget" && member.name === "onclick").includedFrom, "GlobalEventHandlers");
});

test("parser handles partial interfaces, callback interfaces, dictionaries, unions, and iterable declarations", () => {
  const source = `[Exposed=(Window,Worker), SecureContext]\npartial interface Child : Parent {\n  constructor(optional (DOMString or long)? value = null);\n  iterable<DOMString>;\n};\ncallback interface Listener : EventTarget { undefined handleEvent(Event event); };\ncallback Completion = Promise<DOMString> (optional long count = 1);\ndictionary ChildInit : BaseInit { required DOMString name; sequence<long> values = []; };`;
  const definitions = parseWebIDL(source, "inline.idl");
  const child = definitions.find((definition) => definition.name === "Child");
  assert.equal(child.partial, true);
  assert.equal(child.inherited, "Parent");
  assert.equal(child.members.find((member) => member.kind === "iterable").type, "DOMString");
  assert.equal(definitions.find((definition) => definition.kind === "callback-interface").inherited, "EventTarget");
  assert.equal(definitions.find((definition) => definition.kind === "callback").returnType, "Promise<DOMString>");
  const dictionary = definitions.find((definition) => definition.kind === "dictionary");
  assert.equal(dictionary.inherited, "BaseInit");
  assert.equal(dictionary.members[0].required, true);
  assert.equal(dictionary.members[1].default, "[]");
});
