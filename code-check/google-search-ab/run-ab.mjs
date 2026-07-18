#!/usr/bin/env node
/**
 * Google Search A/B debug harness
 *
 *   Lane OK:   mature cookies (Profile 45 export → Cookies.json)
 *   Lane FAIL: empty cookie jar (same profile fingerprint)
 *
 *   node code-check/google-search-ab/run-ab.mjs
 *   node code-check/google-search-ab/run-ab.mjs --q "velora browser"
 *   node code-check/google-search-ab/run-ab.mjs --skip-export   # use existing jar
 *   node code-check/google-search-ab/run-ab.mjs --fail-only
 *   node code-check/google-search-ab/run-ab.mjs --ok-only
 *
 * Output: code-check/google-search-ab/runs/<timestamp>/
 *   ok/  fail/  REPORT.md  diff.json  SUMMARY.txt
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureRun, jarPathForProfile, DEFAULT_PROFILE, DEFAULT_Q } from "./lib/capture.mjs";
import { buildReport } from "./lib/report.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "../..");
const ROOT = __dirname;

const CHROME_P45 =
  process.env.VELORA_CHROME_COOKIE_DB ??
  join(
    process.env.HOME,
    "Library/Application Support/Google/Chrome/Profile 45/Cookies",
  );
const EXPORT_PY = join(REPO, "scripts/export-chrome-live-cookies.py");
const PYTHON =
  process.env.VELORA_COOKIE_PYTHON ??
  join(REPO, "../velora-run/.venv-cookies/bin/python");

function parseArgs(argv) {
  const out = {
    q: process.env.VELORA_Q ?? DEFAULT_Q,
    profile: process.env.VELORA_PROFILE ?? DEFAULT_PROFILE,
    skipExport: false,
    okOnly: false,
    failOnly: false,
    maxSec: Number(process.env.VELORA_MAX_SEC ?? 22),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--q" || a === "--query") out.q = argv[++i] ?? out.q;
    else if (a === "--profile") out.profile = argv[++i] ?? out.profile;
    else if (a === "--skip-export") out.skipExport = true;
    else if (a === "--ok-only") out.okOnly = true;
    else if (a === "--fail-only") out.failOnly = true;
    else if (a === "--max-sec") out.maxSec = Number(argv[++i] ?? out.maxSec);
  }
  out.url = `https://www.google.com/search?q=${encodeURIComponent(out.q)}`;
  return out;
}

function exportProfile45(profile) {
  if (!existsSync(PYTHON)) {
    console.error(`Missing python with browser_cookie3: ${PYTHON}`);
    process.exit(2);
  }
  if (!existsSync(CHROME_P45)) {
    console.error(`Chrome Profile 45 Cookies not found: ${CHROME_P45}`);
    process.exit(2);
  }
  console.log(`[export] Profile 45 → ${profile}`);
  const r = spawnSync(
    PYTHON,
    [
      EXPORT_PY,
      "--cookie-file",
      CHROME_P45,
      "--profile",
      profile,
    ],
    { cwd: REPO, encoding: "utf8" },
  );
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  if (r.status !== 0) {
    console.error(`[export] failed status=${r.status}`);
    process.exit(r.status || 1);
  }
}

function writeEmptyJar(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "[]\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = join(ROOT, "runs", stamp);
  const okDir = join(runDir, "ok");
  const failDir = join(runDir, "fail");
  mkdirSync(okDir, { recursive: true });
  mkdirSync(failDir, { recursive: true });

  console.log(`[ab] runDir=${runDir}`);
  console.log(`[ab] query=${args.q}`);
  console.log(`[ab] profile=${args.profile}`);
  console.log(`[ab] url=${args.url}`);

  const liveJar = jarPathForProfile(args.profile);
  const okJar = join(okDir, "Cookies.json");
  const failJar = join(failDir, "Cookies.json");

  // --- prepare jars ---
  if (!args.failOnly) {
    if (!args.skipExport) {
      exportProfile45(args.profile);
    }
    if (!existsSync(liveJar)) {
      console.error(`No live jar at ${liveJar}. Run without --skip-export.`);
      process.exit(2);
    }
    copyFileSync(liveJar, okJar);
    console.log(`[ab] OK jar copied (${readFileSync(okJar, "utf8").length} bytes)`);
  }

  if (!args.okOnly) {
    writeEmptyJar(failJar);
    console.log(`[ab] FAIL jar empty []`);
  }

  writeFileSync(
    join(runDir, "run-config.json"),
    JSON.stringify(
      {
        stamp,
        args,
        chromeCookieDb: CHROME_P45,
        liveJar,
        okJar,
        failJar,
        note:
          "OK uses mature Profile 45 cookies; FAIL uses empty jar. Same profile binary.",
      },
      null,
      2,
    ),
  );

  let okMeta = null;
  let failMeta = null;

  if (!args.failOnly) {
    console.log("\n========== LANE OK (mature cookies) ==========");
    okMeta = await captureRun({
      label: "ok",
      outDir: okDir,
      profile: args.profile,
      url: args.url,
      cookieJarPath: okJar,
      maxSec: args.maxSec,
    });
    console.log(
      `[ok] tier=${okMeta.tier} htmlLen=${okMeta.htmlLen} wireHops=${okMeta.wireHopCount} hop1cookie=${okMeta.wireHops?.[0]?.cookieBytes}`,
    );
  }

  if (!args.okOnly) {
    console.log("\n========== LANE FAIL (empty jar) ==========");
    failMeta = await captureRun({
      label: "fail",
      outDir: failDir,
      profile: args.profile,
      url: args.url,
      cookieJarPath: failJar,
      maxSec: args.maxSec,
    });
    console.log(
      `[fail] tier=${failMeta.tier} htmlLen=${failMeta.htmlLen} wireHops=${failMeta.wireHopCount} hop1cookie=${failMeta.wireHops?.[0]?.cookieBytes}`,
    );
  }

  if (okMeta && failMeta) {
    const { mdPath, report } = buildReport({
      okDir,
      failDir,
      outDir: runDir,
      query: args.q,
    });
    const summary = [
      `Google Search A/B — ${stamp}`,
      `Query: ${args.q}`,
      ``,
      `OK:   tier=${okMeta.tier}  htmlLen=${okMeta.htmlLen}  hop1CookieB=${okMeta.wireHops?.[0]?.cookieBytes ?? 0}  hops=${okMeta.wireHopCount}`,
      `FAIL: tier=${failMeta.tier}  htmlLen=${failMeta.htmlLen}  hop1CookieB=${failMeta.wireHops?.[0]?.cookieBytes ?? 0}  hops=${failMeta.wireHopCount}`,
      ``,
      `Primary: ${report.summary.primaryCauseHypothesis}`,
      ``,
      `Report: ${mdPath}`,
      `Diff JSON: ${join(runDir, "diff.json")}`,
    ].join("\n");
    writeFileSync(join(runDir, "SUMMARY.txt"), summary + "\n");
    // symlink-ish latest pointer
    writeFileSync(join(ROOT, "runs/LATEST"), stamp + "\n");
    console.log("\n" + summary);
  } else {
    console.log("\n[ab] single-lane done — open meta.json in run dir");
    writeFileSync(join(ROOT, "runs/LATEST"), stamp + "\n");
  }

  // Exit code: 0 if both ran and OK is SERP; 1 otherwise when dual-lane
  if (okMeta && failMeta) {
    process.exit(okMeta.tier === "SERP" ? 0 : 2);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
