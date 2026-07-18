#!/usr/bin/env node
/**
 * Product Google SERP path (proven): thin guest jar → Velora search.
 *
 * Default jar: code-check/google-search-ab/runs/profile55-search/Cookies.json
 * Or live export: --live-chrome-profile 55
 *
 *   node scripts/google-serp-product.mjs --q "velora browser"
 *   node scripts/google-serp-product.mjs --live-chrome-profile 55 --q velora
 *   npm run google:serp-product -- --q "test"
 *
 * Exit 0 = serp_ok, 2 = fail.
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { captureRun, DEFAULT_PROFILE } from "../code-check/google-search-ab/lib/capture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const OUT = join(REPO, "code-check/tmp/google-serp-product");
const DEFAULT_THIN_JAR = join(
  REPO,
  "code-check/google-search-ab/runs/profile55-search/Cookies.json",
);
const EXPORT_PY = join(REPO, "scripts/export-chrome-live-cookies.py");
const PYTHON =
  process.env.VELORA_COOKIE_PYTHON ??
  join(REPO, "../velora-run/.venv-cookies/bin/python");

function parseArgs(argv) {
  const out = {
    q: "velora browser",
    jar: DEFAULT_THIN_JAR,
    live: null,
    maxSec: 22,
    profile: DEFAULT_PROFILE,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--q") out.q = argv[++i];
    else if (a === "--jar") out.jar = resolve(argv[++i]);
    else if (a === "--live-chrome-profile") out.live = argv[++i];
    else if (a === "--max-sec") out.maxSec = Number(argv[++i] || 22);
    else if (a === "--profile") out.profile = argv[++i];
  }
  return out;
}

function exportLive(profileNum, dest) {
  const db = join(
    homedir(),
    "Library/Application Support/Google/Chrome",
    `Profile ${profileNum}`,
    "Cookies",
  );
  if (!existsSync(db)) throw new Error(`Chrome Cookies missing: ${db}`);
  if (!existsSync(PYTHON)) throw new Error(`Missing python: ${PYTHON}`);
  const r = spawnSync(PYTHON, [EXPORT_PY, "--cookie-file", db, "--out", dest], {
    cwd: REPO,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    throw new Error(`export failed: ${(r.stderr || r.stdout || "").slice(-400)}`);
  }
  if (!existsSync(dest)) throw new Error(`no jar written: ${dest}`);
}

function verdictOf(snapshot) {
  const s = snapshot?.signals || {};
  if (s.sorry || s.recaptcha) return "blocked_sorry_captcha";
  if (s.knitsail && !s.rso) return "knitsail_bootstrap";
  if (s.rso || (snapshot?.results?.length ?? 0) > 0) return "serp_ok";
  if ((snapshot?.htmlLen ?? 0) > 5000) return "loaded_no_serp";
  return "empty_or_incomplete";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(OUT, { recursive: true });
  const jar = join(OUT, "Cookies.json");

  if (args.live) {
    console.log(`[export] live Chrome Profile ${args.live}`);
    exportLive(args.live, jar);
  } else {
    if (!existsSync(args.jar)) {
      throw new Error(`jar not found: ${args.jar} (use --live-chrome-profile 55)`);
    }
    copyFileSync(args.jar, jar);
    console.log(`[jar] ${args.jar}`);
  }

  const jarArr = JSON.parse(readFileSync(jar, "utf8"));
  console.log(`[jar] cookies=${jarArr.length}`);

  const url = `https://www.google.com/search?q=${encodeURIComponent(args.q)}&hl=en`;
  const cap = await captureRun({
    label: "product",
    outDir: OUT,
    profile: args.profile,
    url,
    cookieJarPath: jar,
    maxSec: args.maxSec,
  });

  const snapshot =
    cap.snapshot ||
    (existsSync(join(OUT, "snapshot.json"))
      ? JSON.parse(readFileSync(join(OUT, "snapshot.json"), "utf8"))
      : null);
  const verdict = cap.error ? "error" : verdictOf(snapshot);
  const report = {
    verdict,
    serp: verdict === "serp_ok",
    q: args.q,
    jarCookies: jarArr.length,
    htmlLen: snapshot?.htmlLen ?? cap.htmlLen,
    results: snapshot?.results?.length ?? 0,
    href: snapshot?.href,
    signals: snapshot?.signals,
    out: OUT,
    error: cap.error || null,
  };
  writeFileSync(join(OUT, "PRODUCT.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.serp ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
