#!/usr/bin/env node
// Build Velora ReleaseFast and write zig-out/bin/velora.build.json for benchmark preflight.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const metaPath = resolve(repoRoot, "zig-out/bin/velora.build.json");
const optimize = "ReleaseFast";

const build = spawnSync("zig", ["build", "-Doptimize=ReleaseFast"], {
    cwd: repoRoot,
    stdio: "inherit",
});
if (build.status !== 0) {
    process.exit(build.status ?? 1);
}

if (!existsSync(veloraBin)) {
    console.error(`[bench-preflight] binary missing after build: ${veloraBin}`);
    process.exit(1);
}

mkdirSync(dirname(metaPath), { recursive: true });
writeFileSync(
    metaPath,
    `${JSON.stringify(
        {
            optimize,
            builtAt: new Date().toISOString(),
            binary: veloraBin,
            zigArgs: ["build", "-Doptimize=ReleaseFast"],
        },
        null,
        2,
    )}\n`,
);

console.log(`[bench-preflight] ${optimize} binary ready: ${veloraBin}`);