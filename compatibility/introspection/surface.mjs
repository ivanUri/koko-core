import { stableJson } from "../lib/model.mjs";

export const surfaceExpression = ({ globals = [] } = {}) => `(() => {
  const safe = (value) => {
    if (typeof value === "function") return { type: "function", name: value.name, length: value.length };
    if (typeof value === "symbol") return { type: "symbol", description: value.description ?? null, key: Symbol.keyFor(value) ?? null };
    if (value === null) return null;
    if (typeof value === "object") return { type: "object" };
    return { type: typeof value, value };
  };
  const descriptor = (object, name) => {
    const d = Object.getOwnPropertyDescriptor(object, name);
    if (!d) return null;
    return {
      configurable: !!d.configurable, enumerable: !!d.enumerable,
      writable: "writable" in d ? !!d.writable : null,
      value: "value" in d ? safe(d.value) : null,
      get: "get" in d ? safe(d.get) : null, set: "set" in d ? safe(d.set) : null,
    };
  };
  const own = (object) => Reflect.ownKeys(object).map((key) => typeof key === "symbol" ? { symbol: safe(key) } : key).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const describe = (name) => {
    const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    if (!globalDescriptor) return { name, present: false };
    const value = "value" in globalDescriptor ? globalDescriptor.value : undefined;
    if (value === undefined && !("get" in globalDescriptor)) return { name, present: true, value: null, globalDescriptor: descriptor(globalThis, name) };
    const prototypeDescriptor = value && (typeof value === "function" || typeof value === "object") ? Object.getOwnPropertyDescriptor(value, "prototype") : null;
    const prototype = prototypeDescriptor && "value" in prototypeDescriptor ? prototypeDescriptor.value : null;
    const prototypeNames = prototype ? own(prototype) : [];
    return {
      name, present: true, value: safe(value), globalDescriptor: descriptor(globalThis, name),
      ownKeys: own(value),
      descriptors: Object.fromEntries(Reflect.ownKeys(value).map((key) => [typeof key === "symbol" ? "@@" + (key.description ?? "") : key, descriptor(value, key)])),
      prototype: prototype ? {
        ownKeys: prototypeNames,
        descriptors: Object.fromEntries(Reflect.ownKeys(prototype).map((key) => [typeof key === "symbol" ? "@@" + (key.description ?? "") : key, descriptor(prototype, key)])),
        parentName: Object.getPrototypeOf(prototype)?.constructor?.name ?? null,
      } : null,
      toStringTag: prototype ? descriptor(prototype, Symbol.toStringTag) : null,
    };
  };
  return { globals: ${JSON.stringify(globals)}.map(describe), capturedAt: "runtime" };
})()`;

export async function collectSurface(evaluate, options = {}) {
  return evaluate(surfaceExpression(options));
}

function diffValue(expected, actual, path, differences) {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return;
  if (expected === undefined) { differences.push({ path, kind: "unexpected", expected: undefined, actual }); return; }
  if (actual === undefined) { differences.push({ path, kind: "missing", expected, actual: undefined }); return; }
  if (!expected || !actual || typeof expected !== "object" || typeof actual !== "object") {
    differences.push({ path, kind: "changed", expected, actual });
    return;
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of [...keys].sort()) diffValue(expected[key], actual[key], `${path}.${key}`, differences);
}

export function compareSurfaces(expected, actual) {
  const differences = [];
  diffValue(expected, actual, "$", differences);
  return { equal: differences.length === 0, differences };
}

export function surfaceJson(surface) {
  return stableJson(surface);
}
