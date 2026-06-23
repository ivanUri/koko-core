#!/usr/bin/env node
/**
 * Run the local Turnstile smoke test (auto-pass or interactive).
 *
 * Usage:
 *   node code-check/sites/recaptcha/run-turnstile-local-test.mjs
 *   node code-check/sites/recaptcha/run-turnstile-local-test.mjs --interactive
 *   npm run test:site:turnstile:local
 *   npm run test:site:turnstile:local:interactive
 *
 * Requires `zig build` (zig-out/bin/velora) and a built SDK (`npm run build:sdk`).
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const testScript = resolve(here, "turnstile-local-test.mjs");
const sdkEntry = resolve(repoRoot, "sdk/dist/index.js");

function fail(msg) {
    console.error(msg);
    process.exit(1);
}

if (!existsSync(veloraBin)) {
    fail(`Velora binary not found.\n  Run: zig build\n  Expected: ${veloraBin}`);
}

if (!existsSync(sdkEntry)) {
    fail(`SDK not built.\n  Run: npm run build:sdk\n  Expected: ${sdkEntry}`);
}

const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [testScript, ...args], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
});

process.exit(result.status ?? 1);