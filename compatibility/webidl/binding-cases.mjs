import { stableId } from "../lib/model.mjs";

export const BINDING_CASE_KINDS = Object.freeze([
  "required-argument",
  "explicit-undefined",
  "nullable",
  "dom-string",
  "usv-string",
  "byte-string",
  "boolean",
  "integer",
  "clamp",
  "enforce-range",
  "floating-point",
  "enum",
  "dictionary",
  "sequence",
  "record",
  "union",
  "overload",
  "variadic",
  "receiver-brand",
  "cross-realm",
]);

function caseRecord(kind, expression, expected, notes) {
  return { id: stableId(["webidl", kind, String(expression)]), kind, expression, expected, notes };
}

/**
 * Generate side-effect-free binding probes for an operation supplied by a
 * fixture. The generated expressions are deliberately API-neutral: callers
 * provide the interface and operation names, while the expected result records
 * the WebIDL conversion contract that a Chromium/Koko executor must compare.
 */
export function generateBindingCases({ interfaceName, operationName, fixtureExpression = "globalThis.__compatFixture" } = {}) {
  if (!interfaceName || !operationName) throw new TypeError("interfaceName and operationName are required");
  const call = `${fixtureExpression}.${operationName}`;
  return [
    caseRecord("required-argument", `Reflect.apply(${call}, ${fixtureExpression}, [])`, { throws: "TypeError" }, "Missing required argument"),
    caseRecord("explicit-undefined", `Reflect.apply(${call}, ${fixtureExpression}, [undefined])`, { throws: "TypeError" }, "Distinguish omitted and explicit undefined when the IDL type requires it"),
    caseRecord("dom-string", `Reflect.apply(${call}, ${fixtureExpression}, [null])`, { conversion: "DOMString", value: "null" }, "DOMString converts null to the string null"),
    caseRecord("boolean", `Reflect.apply(${call}, ${fixtureExpression}, [0])`, { conversion: "boolean", value: false }, "Boolean conversion follows ECMAScript truthiness"),
    caseRecord("integer", `Reflect.apply(${call}, ${fixtureExpression}, [4294967297])`, { conversion: "unsigned long", value: 1 }, "Integer conversion uses WebIDL modulo semantics unless EnforceRange/Clamp applies"),
    caseRecord("sequence", `Reflect.apply(${call}, ${fixtureExpression}, [[1, 2]])`, { conversion: "sequence", length: 2 }, "Sequence conversion reads the iterable"),
    caseRecord("receiver-brand", `Reflect.apply(${call}, Object.create(${fixtureExpression}), [])`, { throws: "TypeError" }, "Brand validation rejects an unrelated receiver"),
    caseRecord("cross-realm", `Reflect.apply(${call}, ${fixtureExpression}, [globalThis])`, { realm: "same-result" }, "A compatible object from another realm must retain conversion semantics"),
  ].map((probe) => ({ ...probe, interface: interfaceName, operation: operationName }));
}
