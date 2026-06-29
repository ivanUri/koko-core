#!/usr/bin/env node
/**
 * Export cookies from the user's running Google Chrome (macOS Keychain decrypt).
 * Requires one-time venv: google-search-debug/tmp/cookie-venv
 *
 *   node google-search-debug/scripts/export-chrome-live-cookies.mjs
 *   node google-search-debug/scripts/export-chrome-live-cookies.mjs --domain google.com
 */
import { mkdir, writeFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import { REPO } from "../lib/cdp.mjs";

const VENV_PY = resolve(REPO, "google-search-debug/tmp/cookie-venv/bin/python3");

function parseArgs(argv) {
    const out = {
        out: resolve(REPO, "browser/profiles/assets/chrome-local-huys-macbook-pro-google-cookies.json"),
        domain: "google.com",
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--out") out.out = resolve(argv[++i]);
        else if (a === "--domain") out.domain = argv[++i];
    }
    return out;
}

function ensureVenv() {
    if (existsSync(VENV_PY)) return;
    const venvDir = resolve(REPO, "google-search-debug/tmp/cookie-venv");
    console.log("[setup] creating cookie venv + browser-cookie3...");
    const venv = spawnSync("python3", ["-m", "venv", venvDir], { cwd: REPO, stdio: "inherit" });
    if (venv.status !== 0) throw new Error("venv create failed");
    const pip = spawnSync(resolve(venvDir, "bin/pip"), ["install", "browser-cookie3"], {
        cwd: REPO, stdio: "inherit",
    });
    if (pip.status !== 0) throw new Error("pip install browser-cookie3 failed");
}

const PY = `
import json, sys
import browser_cookie3
domain = sys.argv[1]
out = []
for c in browser_cookie3.chrome(domain_name=domain):
    same = "Lax"
    if c.name == "__Secure-STRP": same = "Strict"
    elif c.name == "NID": same = "None"
    row = {
        "name": c.name, "value": c.value, "domain": c.domain,
        "path": c.path or "/", "secure": bool(c.secure),
        "httpOnly": c.name in ("NID", "AEC") or c.name.startswith("__Secure-"),
        "sameSite": same,
    }
    if c.expires: row["expires"] = c.expires
    out.append(row)
print(json.dumps(out))
`;

async function main() {
    const args = parseArgs(process.argv.slice(2));
    ensureVenv();

    const run = spawnSync(VENV_PY, ["-c", PY, args.domain], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    if (run.status !== 0) {
        console.error(run.stderr || run.stdout);
        throw new Error("browser_cookie3 export failed");
    }

    const cookies = JSON.parse(run.stdout);
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, JSON.stringify(cookies, null, 2));

    const names = [...new Set(cookies.map((c) => c.name))].sort();
    const nid = cookies.find((c) => c.name === "NID");
    console.log(`Exported ${cookies.length} cookies for *${args.domain}*`);
    console.log(`Names (${names.length}): ${names.slice(0, 20).join(", ")}${names.length > 20 ? "..." : ""}`);
    console.log(`NID length: ${nid?.value?.length ?? 0}`);
    console.log(`Saved: ${args.out}`);
}

main().catch((e) => { console.error(e); process.exit(2); });