import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createAdapterFactories, detectChrome } from "../../bench/adapters/index.mjs";
import { parseArgs, required } from "../lib/io.mjs";
import { writeJson } from "../lib/io.mjs";
import { collectSurface } from "./surface.mjs";

const { options } = parseArgs(process.argv.slice(2));
const engines = String(options.engines ?? "chromium-cdp,koko-cdp").split(",").filter(Boolean);
const globals = String(options.globals ?? "Window,Document,Navigator,Element,Event,URL,fetch,ReadableStream").split(",").filter(Boolean);
const output = required(options, "output");
const projectRoot = resolve(options.root ?? process.cwd());
const factories = createAdapterFactories(engines, {
  projectRoot,
  chromeBin: detectChrome(options["chrome-bin"]),
  kokoBin: options["koko-bin"] ?? resolve(projectRoot, "zig-out/bin/koko"),
  timeoutMs: Number(options.timeout ?? 30_000),
});
const result = { schemaVersion: 1, kind: "runtime-surface", generatedAt: new Date().toISOString(), engines: {} };
for (const factory of factories) {
  const adapter = await factory.create().launch();
  try {
    const session = await adapter.newSession();
    try { result.engines[factory.id] = { label: factory.label, browserVersion: adapter.browserVersion ?? adapter.version, surface: await collectSurface((expression) => session.evaluate(expression), { globals }) }; }
    finally { await session.close(); }
  } finally { await adapter.close(); }
}
await mkdir(resolve(output, ".."), { recursive: true });
await writeJson(output, result);
