#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const urlFile = process.argv[2] || "/tmp/velora-sgss-url.txt";
if (!existsSync(urlFile)) {
    console.error("missing", urlFile);
    process.exit(2);
}
const url = readFileSync(urlFile, "utf8").trim();
const bin = resolve(REPO, "zig-out/bin/velora");
const r = spawnSync(bin, [
    "fetch", "--browser-profile", "chrome-local-huys-macbook-pro", url,
], { cwd: REPO, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, env: { ...process.env, VELORA_ROOT: REPO } });
process.stdout.write(r.stdout || "");
process.stderr.write(r.stderr || "");
process.exit(r.status ?? 1);