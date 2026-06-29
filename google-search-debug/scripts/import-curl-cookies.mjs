#!/usr/bin/env node
/**
 * Parse curl -b 'name=val; ...' → Velora cookie JSON.
 *
 *   node google-search-debug/scripts/import-curl-cookies.mjs \
 *     --cookie-string 'NID=...; DV=...' \
 *     --out browser/profiles/assets/chrome-local-huys-macbook-pro-google-cookies.json
 */
import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { REPO } from "../lib/cdp.mjs";

function parseArgs(argv) {
    const out = {
        out: resolve(REPO, "browser/profiles/assets/chrome-local-huys-macbook-pro-google-cookies.json"),
        cookieString: null,
        cookieFile: null,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--out") out.out = resolve(argv[++i]);
        else if (a === "--cookie-string") out.cookieString = argv[++i];
        else if (a === "--cookie-file") out.cookieFile = resolve(argv[++i]);
    }
    if (!out.cookieString && !out.cookieFile) throw new Error("Need --cookie-string or --cookie-file");
    return out;
}

function parseCookieString(raw) {
    const secureNames = new Set(["NID", "AEC", "__Secure-STRP", "__Secure-BUCKET", "__Secure-ENID"]);
    return raw.split(";").map((p) => p.trim()).filter(Boolean).map((part) => {
        const eq = part.indexOf("=");
        const name = part.slice(0, eq);
        const value = part.slice(eq + 1);
        const hostOnly = name === "DV";
        return {
            name,
            value,
            domain: hostOnly ? "www.google.com" : ".google.com",
            path: "/",
            secure: secureNames.has(name) || name.startsWith("__Secure-"),
            httpOnly: name === "NID" || name === "AEC" || name.startsWith("__Secure-"),
            sameSite: name === "__Secure-STRP" ? "Strict" : name === "NID" ? "None" : "Lax",
        };
    });
}

const args = parseArgs(process.argv.slice(2));
if (args.cookieFile) args.cookieString = (await readFile(args.cookieFile, "utf8")).trim();
const cookies = parseCookieString(args.cookieString);
await mkdir(dirname(args.out), { recursive: true });
await writeFile(args.out, JSON.stringify(cookies, null, 2));
console.log(`wrote ${cookies.length} cookies → ${args.out}`);
console.log(`names: ${cookies.map((c) => c.name).join(", ")}`);