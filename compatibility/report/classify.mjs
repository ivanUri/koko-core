import { API_STATUSES, CATEGORIES, countBy, emptyCompatibilityReport, stableId } from "../lib/model.mjs";

function membersFor(inventory, interfaceName) {
  return inventory.members.filter((member) => member.interface === interfaceName);
}

function actualInterface(actual, name) {
  return actual.interfaces?.find((item) => item.name === name) ?? actual.globals?.find((item) => item.name === name && item.present) ?? null;
}

function memberPresent(actual, member) {
  const api = actualInterface(actual, member.interface);
  if (!api || api.present === false) return false;
  const staticMember = [...(api.members ?? []), ...(api.constructors ?? [])].find((candidate) => candidate.name === member.name);
  if (staticMember) return true;
  const descriptors = api.prototype?.descriptors ?? {};
  const staticDescriptors = api.descriptors ?? {};
  return Boolean((member.static ? staticDescriptors : descriptors)[member.name]);
}

function actualMember(actual, member) {
  const api = actualInterface(actual, member.interface);
  return [...(api?.members ?? []), ...(api?.constructors ?? [])].find((candidate) => candidate.name === member.name) ?? null;
}

function resultStatus({ present, verified, meaningful, unsupported = false, incorrect = false }) {
  if (unsupported) return "UNSUPPORTED_BY_DESIGN";
  if (incorrect) return "INCORRECT";
  if (!present) return "MISSING";
  if (!meaningful) return "STUB";
  if (verified) return "IMPLEMENTED_VERIFIED";
  return "IMPLEMENTED_UNVERIFIED";
}

export function classifyInventory({ expected, actual, behavior = [], unsupported = [] }) {
  const unsupportedSet = new Set(unsupported.map((item) => item.id ?? item));
  const behaviorById = new Map(behavior.map((item) => [item.id, item]));
  const apis = [];
  for (const definition of expected.definitions) {
    const interfaceLike = ["interface", "interface-mixin", "namespace", "callback-interface"].includes(definition.kind);
    const actualDef = actual.interfaces?.find((item) => item.name === definition.name);
    const interfaceId = stableId([expected.source, definition.kind, definition.name]);
    if (!interfaceLike) {
      apis.push({
        id: interfaceId,
        kind: "type-definition",
        name: definition.name,
        category: definition.category,
        context: definition.context,
        source: definition.source,
        status: unsupportedSet.has(interfaceId) ? "UNSUPPORTED_BY_DESIGN" : "UNKNOWN",
        presence: null,
        binding: "UNKNOWN",
        behavior: "UNKNOWN",
        coverage: "UNKNOWN",
        evidence: { expected: definition.id, actual: null, reason: "Type conversion inventory is not available from JsApi registration alone" },
      });
      for (const member of membersFor(expected, definition.name)) {
        apis.push({
          id: member.id,
          kind: member.kind,
          name: `${definition.name}.${member.name ?? member.kind}`,
          interface: definition.name,
          category: member.category,
          context: member.context,
          source: member.source,
          status: unsupportedSet.has(member.id) ? "UNSUPPORTED_BY_DESIGN" : "UNKNOWN",
          presence: null,
          binding: "UNKNOWN",
          behavior: "UNKNOWN",
          coverage: "UNKNOWN",
          evidence: { expected: member.id, actual: null, reason: "Type conversion inventory is not available from JsApi registration alone" },
        });
      }
      continue;
    }
    const interfaceResult = {
      id: interfaceId,
      kind: "interface",
      name: definition.name,
      category: definition.category,
      context: definition.context,
      source: definition.source,
      status: definition.kind === "interface-mixin"
        ? (unsupportedSet.has(interfaceId) ? "UNSUPPORTED_BY_DESIGN" : "NOT_APPLICABLE")
        : resultStatus({ present: Boolean(actualDef), verified: false, meaningful: Boolean(actualDef), unsupported: unsupportedSet.has(interfaceId) }),
      presence: Boolean(actualDef), binding: "UNKNOWN", behavior: "UNKNOWN", coverage: "UNKNOWN",
      evidence: { expected: definition.id, actual: actualDef?.source ?? null },
    };
    apis.push(interfaceResult);
    for (const member of membersFor(expected, definition.name)) {
      const behaviorResult = behaviorById.get(member.id);
      const memberActual = memberPresent(actual, member);
      const implementation = actualMember(actual, member);
      const meaningful = actualDef?.stubMembers
        ? !actualDef.stubMembers.includes(member.name)
        : implementation ? !implementation.signals?.noop && !implementation.signals?.unsupported : memberActual;
      apis.push({
        id: member.id,
        kind: member.kind,
        name: `${definition.name}.${member.name ?? member.kind}`,
        interface: definition.name,
        category: member.category,
        context: member.context,
        source: member.source,
        status: definition.kind === "interface-mixin"
          ? (unsupportedSet.has(member.id) ? "UNSUPPORTED_BY_DESIGN" : "NOT_APPLICABLE")
          : resultStatus({
            present: memberActual,
            verified: behaviorResult?.status === "PASS",
            meaningful,
            incorrect: behaviorResult?.status === "FAIL",
            unsupported: unsupportedSet.has(member.id),
          }),
        presence: memberActual,
        binding: behaviorResult?.binding ?? "UNKNOWN",
        behavior: behaviorResult?.status ?? "UNKNOWN",
        coverage: behaviorResult ? "TESTED" : "UNTESTED",
        evidence: { expected: member.id, actual: memberActual ? definition.name : null },
      });
    }
  }
  apis.sort((a, b) => a.id.localeCompare(b.id));
  return apis;
}

export function buildReport({ expected, actual, behavior = [], tests = [], metadata = {}, unsupported = [] }) {
  const report = emptyCompatibilityReport({ ...metadata, expectedSource: expected.source, actualSource: actual.source ?? "koko" });
  report.scope = {
    contexts: [...new Set(expected.definitions.map((item) => item.context).filter(Boolean))].sort(),
    categories: [...new Set(expected.definitions.map((item) => item.category).filter(Boolean))].sort(),
    sources: [expected.source, actual.source ?? "koko"].sort(),
  };
  report.apis = classifyInventory({ expected, actual, behavior, unsupported });
  report.tests = tests;
  const apiCount = report.apis.length;
  const verified = report.apis.filter((api) => api.status === "IMPLEMENTED_VERIFIED").length;
  report.metrics = {
    api: {
      expected: apiCount,
      byStatus: countBy(report.apis, "status"),
      presence: report.apis.filter((api) => api.presence).length,
      bindingCorrect: report.apis.filter((api) => api.binding === "PASS").length,
      behaviorVerified: verified,
      coverageTested: report.apis.filter((api) => api.coverage === "TESTED").length,
    },
    tests: {
      total: tests.length,
      byStatus: countBy(tests, "status"),
      passed: tests.filter((test) => test.status === "PASS").length,
    },
    categories: Object.fromEntries(CATEGORIES.map((category) => [category, {
      total: report.apis.filter((api) => api.category === category).length,
      byStatus: countBy(report.apis.filter((api) => api.category === category), "status"),
    }]).filter(([, value]) => value.total > 0)),
  };
  return report;
}

export function validateReport(report) {
  for (const api of report.apis ?? []) if (!API_STATUSES.includes(api.status)) throw new Error(`Invalid API status ${api.status} for ${api.id}`);
  return report;
}
