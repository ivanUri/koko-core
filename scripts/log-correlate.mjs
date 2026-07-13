#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const [baseArg, navIdArg] = process.argv.slice(2);
if (!baseArg || !navIdArg) {
    console.error("Usage: node scripts/log-correlate.mjs <logs-dir|latest> <nav_id>");
    process.exit(1);
}

function resolveRunDir(base) {
    const resolved = resolve(base);
    if (existsSync(join(resolved, "meta.json"))) return resolved;
    const latest = join(resolved, "latest");
    if (existsSync(latest)) return latest;
    const entries = readdirSync(resolved)
        .map((name) => ({ path: join(resolved, name), mtime: statSync(join(resolved, name)).mtimeMs }))
        .filter((e) => statSync(e.path).isDirectory())
        .sort((a, b) => b.mtime - a.mtime);
    return entries[0]?.path;
}

function collectLines(runDir, rel) {
    const path = join(runDir, rel);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

const runDir = resolveRunDir(baseArg);
const needle = `$nav_id=${navIdArg}`;
const sources = [
    ["combined", "combined.log"],
    ["core", "core/all.log"],
    ["network", "network/all.log"],
    ["js-console", "js/console.log"],
    ["js-engine", "js/engine.log"],
    ["protocol", "protocol/all.log"],
];

for (const [label, rel] of sources) {
    const hits = collectLines(runDir, rel).filter((l) => l.includes(needle));
    if (hits.length === 0) continue;
    console.log(`\n== ${label} (${hits.length}) ==`);
    for (const line of hits) console.log(line);
}