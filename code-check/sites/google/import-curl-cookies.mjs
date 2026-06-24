#!/usr/bin/env node
// Convert a curl -b cookie string (or Netscape/header export) to Velora --cookie JSON.
// Usage:
//   node import-curl-cookies.mjs --out ./google-session.json \
//     '__Secure-BUCKET=CIcC; NID=532=...; AEC=...'
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(argv) {
    let out = "google-cookies.json";
    let raw = "";
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--out") out = argv[++i];
        else if (!argv[i].startsWith("-")) raw = argv[i];
    }
    if (!raw) throw new Error("Pass cookie string as final argument");
    return { out: resolve(out), raw };
}

function toVeloraCookies(raw) {
    const cookies = [];
    for (const part of raw.split(";")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf("=");
        if (eq <= 0) continue;
        const name = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        cookies.push({
            name,
            value,
            domain: ".google.com",
            path: "/",
            secure: true,
            httpOnly: name !== "__Secure-STRP" && name !== "DV",
            sameSite: name === "__Secure-STRP" ? "Strict" : name === "AEC" ? "Lax" : "None",
        });
    }
    return cookies;
}

const { out, raw } = parseArgs(process.argv.slice(2));
const cookies = toVeloraCookies(raw);
writeFileSync(out, JSON.stringify(cookies, null, 2));
console.log(`wrote ${cookies.length} cookies → ${out}`);
console.log(`test: node search.mjs --cookie ${out} --mode direct --query coingloo.com`);