#!/usr/bin/env node
/**
 * Fail if Zig under src/ contains behavioral site URL specials.
 * Comment-only mentions (// ... fingerprint.com) are allowed.
 *
 * Also flags new host/path specials inside HttpClient (policy belongs in
 * NavigationPlan / RequestParams flags).
 */
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Patterns banned in any non-comment Zig under src/. */
const globalPatterns = ["fingerprint\\.com", "is_fp\\s*="];

/**
 * Patterns banned in HttpClient.zig non-comments (except allowlisted lines).
 * Prefer NavigationPlan / RequestParams flags over URL substring matching.
 */
const httpClientPatterns = [
  "google\\.",
  "/search",
  "sg_ss=",
];

function rgLines(pat, path = "src") {
  try {
    return execSync(`rg -n --glob '*.zig' '${pat}' ${path}`, {
      cwd: REPO,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
  } catch (e) {
    if (e.status === 1) return [];
    throw e;
  }
}

function isCommentLine(content) {
  const trimmed = content.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("///") ||
    trimmed.startsWith("//!")
  );
}

let bad = [];

for (const pat of globalPatterns) {
  for (const line of rgLines(pat)) {
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    if (isCommentLine(m[3])) continue;
    bad.push(line);
  }
}

// HttpClient: ban host/path product specials in non-comment code.
const httpClientFile = "src/core/browser/HttpClient.zig";
for (const pat of httpClientPatterns) {
  for (const line of rgLines(pat, httpClientFile)) {
    const m = line.match(/^([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    if (isCommentLine(m[3])) continue;
    // Allowlist: ResourceType CDP string docs, generic words in strings that
    // are not product host routing (none currently for google./sg_ss=).
    const content = m[3];
    // "//" mid-line comments after code still count as code if code is present.
    bad.push(`[HttpClient] ${line}`);
  }
}

if (bad.length) {
  console.error("Site specials found (host-event-loop / HttpClient policy freeze):");
  for (const l of bad) console.error(" ", l);
  process.exit(1);
}
console.log("lint:no-site-specials OK");
process.exit(0);
