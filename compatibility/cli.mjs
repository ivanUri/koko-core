#!/usr/bin/env node
import { resolve } from "node:path";
import { buildWebIDLInventory } from "./webidl/inventory.mjs";
import { compareSurfaces } from "./introspection/surface.mjs";
import { buildReport, validateReport } from "./report/classify.mjs";
import { renderMarkdown } from "./report/render.mjs";
import { generateTasks } from "./tasks/generate.mjs";
import { parseArgs, readJson, required, writeJson, writeText } from "./lib/io.mjs";

function help() {
  return `Koko WebIDL compatibility framework

Commands:
  update-upstream
  inventory webidl --input <idl-root> --source <name> --output <json>
  inventory koko --root <repo-root> --output <json>
  compare --expected <json> --actual <json> --output <json>
  report --expected <json> --actual <json> --output <json> [--markdown <md>]
  surface-compare --expected <json> --actual <json> --output <json>
  tasks --report <json> --output <json>
  binding-cases --interface <name> --operation <name> --output <json>
  differential --suite <module> --output <json>
  gate --baseline <json> --current <json>
  wpt --command <runner> --test <id> [--arg <arg> ...]

All generated files are deterministic except report generatedAt metadata.
No command modifies Koko production runtime code.
`;
}

const argv = process.argv.slice(2);
const command = argv.shift();
const { options, positionals } = parseArgs(argv);
if (!command || command === "help" || options.help) { process.stdout.write(help()); process.exit(0); }

if (command === "update-upstream") {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [new URL("./upstream/update.mjs", import.meta.url).pathname], { stdio: "inherit" });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
} else if (command === "inventory") {
  const kind = positionals[0];
  const output = required(options, "output");
  if (kind === "webidl") {
    await writeJson(output, await buildWebIDLInventory({ root: required(options, "input"), source: options.source ?? "unknown", category: options.category ?? null, context: options.context ?? "Window" }));
  } else if (kind === "koko") {
    const { buildKokoInventory } = await import("./inventory/koko-api-inventory.mjs");
    await writeJson(output, await buildKokoInventory({ root: resolve(options.root ?? process.cwd()) }));
  } else throw new Error(`Unknown inventory kind: ${kind}`);
} else if (command === "compare" || command === "report") {
  const expected = await readJson(required(options, "expected"));
  const actual = await readJson(required(options, "actual"));
  const behavior = options.behavior ? (await readJson(options.behavior)).results ?? [] : [];
  const tests = options.tests ? (await readJson(options.tests)).results ?? [] : [];
  const report = validateReport(buildReport({ expected, actual, behavior, tests, metadata: { command, actualSource: actual.source ?? "koko" } }));
  if (command === "report") {
    report.tasks = generateTasks(report);
    await writeJson(required(options, "output"), report);
    if (options.markdown) await writeText(options.markdown, renderMarkdown(report));
  } else {
    await writeJson(required(options, "output"), { schemaVersion: 1, expected: expected.source, actual: actual.source ?? "koko", apis: report.apis, metrics: report.metrics });
  }
} else if (command === "surface-compare") {
  const expected = await readJson(required(options, "expected"));
  const actual = await readJson(required(options, "actual"));
  await writeJson(required(options, "output"), compareSurfaces(expected, actual));
} else if (command === "tasks") {
  const report = await readJson(required(options, "report"));
  await writeJson(required(options, "output"), generateTasks(report));
} else if (command === "binding-cases") {
  const { generateBindingCases } = await import("./webidl/binding-cases.mjs");
  await writeJson(required(options, "output"), { schemaVersion: 1, kind: "webidl-binding-cases", cases: generateBindingCases({ interfaceName: required(options, "interface"), operationName: required(options, "operation"), fixtureExpression: options.fixture ?? "globalThis.__compatFixture" }) });
} else if (command === "differential") {
  const { runDifferentialSuite, serializeDifferentialReport } = await import("./differential/index.mjs");
  const module = await import(new URL(resolve(required(options, "suite")), import.meta.url));
  const suite = module.default ?? module.suite ?? (typeof module.createSuite === "function" ? await module.createSuite() : null);
  if (!suite) throw new Error("Suite module must export default, suite, or createSuite()");
  const report = await runDifferentialSuite(suite);
  await writeText(required(options, "output"), serializeDifferentialReport(report));
} else if (command === "gate") {
  const { evaluateGate } = await import("./regression/gate.mjs");
  const result = evaluateGate(await readJson(required(options, "baseline")), await readJson(required(options, "current")));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.pass) process.exitCode = 1;
} else if (command === "wpt") {
  const { runWptTest } = await import("./wpt/runner.mjs");
  const args = [];
  if (options.arg) args.push(...(Array.isArray(options.arg) ? options.arg : [options.arg]));
  const result = await runWptTest({ id: required(options, "test"), command: options.command ?? "wptrunner", args, cwd: options.cwd, timeoutMs: Number(options.timeout ?? 120_000) });
  await writeJson(options.output ?? "compatibility/reports/wpt-results.json", { schemaVersion: 1, results: [result] });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else if (command === "introspect") {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [new URL("./introspection/collect.mjs", import.meta.url).pathname, ...argv], { stdio: "inherit" });
  child.once("exit", (code) => { process.exitCode = code ?? 1; });
} else {
  throw new Error(`Unknown command: ${command}`);
}
