#!/usr/bin/env node

import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const firefoxProfile = process.argv[2] || join(
  homedir(), "Library", "Application Support", "Firefox", "Profiles", "jr9fn2ij.default-release",
);
const output = resolve(process.argv[3] || "exports/firefox-cookies.json");
const source = join(firefoxProfile, "cookies.sqlite");
if (!existsSync(source)) throw new Error(`Firefox cookies database not found: ${source}`);

// Firefox keeps the database locked while running. Read a temporary snapshot,
// never mutate the browser's profile and never expose its path to Koko.
const temp = mkdtempSync(join("/tmp", "koko-firefox-cookie-"));
try {
  const snapshot = join(temp, "cookies.sqlite");
  cpSync(source, snapshot);
  const sql = `select host,name,value,path,expiry,isSecure,isHttpOnly,sameSite from moz_cookies where expiry=0 or expiry > strftime('%s','now')`;
  const rows = JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", snapshot, sql], { encoding: "utf8" }) || "[]");
  const cookies = rows.map((row) => ({
    name: row.name,
    value: row.value,
    domain: row.host,
    path: row.path || "/",
    expires: Number(row.expiry || 0),
    secure: Boolean(row.isSecure),
    httpOnly: Boolean(row.isHttpOnly),
    sameSite: Number(row.sameSite) === 2 ? "strict" : Number(row.sameSite) === 1 ? "lax" : "none",
    partitioned: null,
    partitionSite: null,
    sourceSecure: Boolean(row.isSecure),
    sourcePort: 443,
  }));
  writeFileSync(output, `${JSON.stringify(cookies, null, 2)}\n`);
  console.log(`Imported ${cookies.length} Firefox cookies -> ${output}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
