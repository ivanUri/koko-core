#!/usr/bin/env node
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

const [baseArg, channelArg, ...rest] = process.argv.slice(2);
const follow = rest.includes("--follow") || rest.includes("-f");

if (!baseArg) {
    console.error("Usage: node scripts/log-tail.mjs <logs-dir|latest> [js|core|network|protocol|system] [--follow]");
    process.exit(1);
}

function resolveRunDir(base) {
    const resolved = resolve(base);
    if (resolved.endsWith("/latest") || base === "latest") {
        const parent = resolved.replace(/\/latest$/, "") || join(process.cwd(), "logs");
        const latest = join(parent, "latest");
        if (existsSync(latest)) return latest;
    }
    if (existsSync(join(resolved, "meta.json"))) return resolved;
    if (!existsSync(resolved)) throw new Error(`not found: ${resolved}`);
    const entries = readdirSync(resolved)
        .map((name) => ({ name, path: join(resolved, name), mtime: statSync(join(resolved, name)).mtimeMs }))
        .filter((e) => statSync(e.path).isDirectory())
        .sort((a, b) => b.mtime - a.mtime);
    if (entries.length === 0) throw new Error(`no run folders in ${resolved}`);
    return entries[0].path;
}

function logPath(runDir, channel) {
    const map = {
        js: join(runDir, "js", "console.log"),
        core: join(runDir, "core", "all.log"),
        network: join(runDir, "network", "all.log"),
        protocol: join(runDir, "protocol", "all.log"),
        system: join(runDir, "system", "all.log"),
        combined: join(runDir, "combined.log"),
        errors: join(runDir, "errors.log"),
    };
    return map[channel ?? "combined"] ?? map.combined;
}

const runDir = resolveRunDir(baseArg);
const target = logPath(runDir, channelArg);
console.error(`# ${target}`);
if (!existsSync(target)) {
    console.error(`missing: ${target}`);
    process.exit(1);
}

const stream = createReadStream(target, { encoding: "utf8" });
const rl = createInterface({ input: stream, crlfDelay: Infinity });
for await (const line of rl) console.log(line);
if (follow) console.error("# follow not implemented for completed files");