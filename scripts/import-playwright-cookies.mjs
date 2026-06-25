#!/usr/bin/env node
/**
 * Convert Playwright capture cookies JSON → Velora --cookie format.
 *
 * Usage:
 *   node scripts/import-playwright-cookies.mjs \
 *     "/path/to/playwright-capture/missing-parts/08-cookies.json" \
 *     --out code-check/tmp/google-cookies.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(argv) {
    let input = null;
    let out = resolve("code-check/tmp/google-cookies.json");
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--out") out = resolve(argv[++i]);
        else if (!argv[i].startsWith("-")) input = resolve(argv[i]);
    }
    if (!input) throw new Error("Usage: node import-playwright-cookies.mjs <cookies.json> [--out path]");
    return { input, out };
}

function toVeloraCookie(c) {
    return {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        secure: c.secure ?? true,
        httpOnly: c.httpOnly ?? false,
        sameSite: c.sameSite || "Lax",
        ...(c.expires ? { expires: c.expires } : {}),
    };
}

const { input, out } = parseArgs(process.argv.slice(2));
const raw = JSON.parse(readFileSync(input, "utf8"));
const cookies = (Array.isArray(raw) ? raw : raw.cookies || []).map(toVeloraCookie);
writeFileSync(out, JSON.stringify(cookies, null, 2));
console.log(`wrote ${cookies.length} cookies → ${out}`);
console.log(`test: node scripts/cdp-google-serp-probe.mjs --cookie ${out}`);