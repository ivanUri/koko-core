#!/usr/bin/env node
/**
 * Parallel Velora Google SERP case matrix.
 * Each case uses an isolated Cookies.json + free CDP port (no shared jar races).
 * Stops early when a case reaches serp_ok (unless --no-stop).
 *
 *   node scripts/velora-serp-case-matrix.mjs
 *   node scripts/velora-serp-case-matrix.mjs --only warm-p45,ok-p45
 *   node scripts/velora-serp-case-matrix.mjs --wave live
 *   node scripts/velora-serp-case-matrix.mjs --concurrency 3 --max-sec 22
 *
 * Exit: 0 if any SERP, 2 if none, 3 hang-ish / hard fail budget (per-case).
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
import { captureRun, DEFAULT_PROFILE, DEFAULT_Q } from "../code-check/google-search-ab/lib/capture.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const RUNS = join(REPO, "code-check/google-search-ab/runs");
const OUT_ROOT = join(REPO, "code-check/tmp/serp-case-matrix");
const PYTHON =
  process.env.VELORA_COOKIE_PYTHON ??
  join(REPO, "../velora-run/.venv-cookies/bin/python");
const EXPORT_PY = join(REPO, "scripts/export-chrome-live-cookies.py");

function parseArgs(argv) {
  const out = {
    only: null,
    wave: "saved", // saved | live | all
    concurrency: 3,
    maxSec: 22,
    q: DEFAULT_Q,
    profile: DEFAULT_PROFILE,
    noStop: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--only") out.only = String(argv[++i] || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    else if (a === "--wave") out.wave = argv[++i] || out.wave;
    else if (a === "--concurrency") out.concurrency = Number(argv[++i] || 3);
    else if (a === "--max-sec") out.maxSec = Number(argv[++i] || 22);
    else if (a === "--q") out.q = argv[++i] || out.q;
    else if (a === "--profile") out.profile = argv[++i] || out.profile;
    else if (a === "--no-stop") out.noStop = true;
  }
  return out;
}

function usage() {
  return `velora-serp-case-matrix — parallel Velora SERP cases until serp_ok

Waves:
  saved  jars already on disk under google-search-ab/runs (default)
  live   export Chrome Profile 45/55/56/57 then search
  all    saved then live if no SERP

Cases (saved): empty, fail-thin, profile55, profile56, warm-p45, ok-p45, fake-thin
Cases (live):  live-p45, live-p55, live-p56, live-p57`;
}

function verdictOf(snapshot) {
  const s = snapshot?.signals || {};
  if (s.sorry || s.recaptcha) return "blocked_sorry_captcha";
  if (s.knitsail && !s.rso) return "knitsail_bootstrap";
  if (s.enablejs && !s.rso) return "soft_block_enablejs";
  if (s.rso || (snapshot?.results?.length ?? 0) > 0) return "serp_ok";
  if ((snapshot?.htmlLen ?? 0) > 5000) return "loaded_no_serp_markers";
  if (snapshot?.error) return "error";
  return "empty_or_incomplete";
}

function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}

function writeEmptyJar(path) {
  writeFileSync(path, "[]\n");
  return path;
}

function copyJar(src, dest) {
  if (!existsSync(src)) throw new Error(`missing jar: ${src}`);
  copyFileSync(src, dest);
  return dest;
}

function chromeCookieDb(profileNum) {
  const name = profileNum === "Default" ? "Default" : `Profile ${profileNum}`;
  return join(
    homedir(),
    "Library/Application Support/Google/Chrome",
    name,
    "Cookies",
  );
}

function exportLiveToJar(profileNum, jarPath) {
  const db = chromeCookieDb(profileNum);
  if (!existsSync(db)) throw new Error(`Chrome Cookies DB missing: ${db}`);
  if (!existsSync(PYTHON)) throw new Error(`Missing cookie python: ${PYTHON}`);
  const r = spawnSync(
    PYTHON,
    [EXPORT_PY, "--cookie-file", db, "--out", jarPath],
    { cwd: REPO, encoding: "utf8" },
  );
  if (r.status !== 0) {
    throw new Error(
      `export P${profileNum} failed: ${(r.stderr || r.stdout || "").slice(-500)}`,
    );
  }
  if (!existsSync(jarPath)) throw new Error(`export produced no jar: ${jarPath}`);
  return jarPath;
}

function savedCaseDefs() {
  return [
    {
      id: "empty",
      desc: "empty cookie jar (cold)",
      prepare: (jar) => writeEmptyJar(jar),
    },
    {
      id: "fail-thin",
      desc: "thin fail jar (NID/AEC/STRP/SG_SS) — historically knitsail",
      prepare: (jar) =>
        copyJar(join(RUNS, "2026-07-16T15-14-57-821Z/fail/Cookies.json"), jar),
    },
    {
      id: "profile55",
      desc: "Profile 55 export snapshot (thin guest)",
      prepare: (jar) => copyJar(join(RUNS, "profile55-search/Cookies.json"), jar),
    },
    {
      id: "profile56",
      desc: "Profile 56 export snapshot (thin)",
      prepare: (jar) => copyJar(join(RUNS, "profile56-search/Cookies.json"), jar),
    },
    {
      id: "fake-thin",
      desc: "fake-cookie-search jar",
      prepare: (jar) => copyJar(join(RUNS, "fake-cookie-search/Cookies.json"), jar),
    },
    {
      id: "warm-p45",
      desc: "warm Profile 45-class jar (~120 cookies)",
      prepare: (jar) =>
        copyJar(join(RUNS, "warm-p45-after-cold-fixes/Cookies.json"), jar),
    },
    {
      id: "ok-p45",
      desc: "A/B OK lane mature jar (~121 cookies)",
      prepare: (jar) =>
        copyJar(join(RUNS, "2026-07-16T15-14-57-821Z/ok/Cookies.json"), jar),
    },
  ];
}

function liveCaseDefs() {
  return ["45", "55", "56", "57"].map((n) => ({
    id: `live-p${n}`,
    desc: `live export Chrome Profile ${n} → Velora search`,
    prepare: (jar) => exportLiveToJar(n, jar),
    live: true,
  }));
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let i = 0;
  let stop = false;
  async function worker() {
    while (!stop) {
      const idx = i++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx, () => {
        stop = true;
      });
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results.filter((r) => r != null);
}

async function runCase(def, args, stampRoot) {
  const caseDir = ensureDir(join(stampRoot, def.id));
  const jarPath = join(caseDir, "Cookies.json");
  const t0 = Date.now();
  const base = {
    id: def.id,
    desc: def.desc,
    jarPath,
    outDir: caseDir,
  };
  try {
    def.prepare(jarPath);
    let jarSummary = { total: 0 };
    try {
      const arr = JSON.parse(readFileSync(jarPath, "utf8"));
      jarSummary = {
        total: arr.length,
        names: [...new Set(arr.map((c) => c.name))].sort().slice(0, 30),
        hasSID: arr.some((c) => c.name === "SID" || c.name === "__Secure-1PSID"),
        hasNID: arr.some((c) => c.name === "NID"),
      };
    } catch {}

    console.log(`[case ${def.id}] start jar=${jarSummary.total} → capture`);
    const url = `https://www.google.com/search?q=${encodeURIComponent(args.q)}`;
    const cap = await captureRun({
      label: def.id,
      outDir: caseDir,
      profile: args.profile,
      url,
      cookieJarPath: jarPath,
      maxSec: args.maxSec,
    });

    const snapshot = cap.snapshot || (existsSync(join(caseDir, "snapshot.json"))
      ? JSON.parse(readFileSync(join(caseDir, "snapshot.json"), "utf8"))
      : null);
    const verdict = cap.error ? "error" : verdictOf(snapshot);
    const result = {
      ...base,
      jarSummary,
      verdict,
      serp: verdict === "serp_ok",
      htmlLen: snapshot?.htmlLen ?? cap.htmlLen ?? null,
      results: snapshot?.results?.length ?? 0,
      signals: snapshot?.signals ?? null,
      href: snapshot?.href ?? null,
      title: snapshot?.title ?? null,
      error: cap.error || null,
      elapsedMs: Date.now() - t0,
    };
    writeFileSync(join(caseDir, "CASE.json"), JSON.stringify(result, null, 2));
    console.log(
      `[case ${def.id}] ${verdict} htmlLen=${result.htmlLen} results=${result.results} ${result.elapsedMs}ms`,
    );
    return result;
  } catch (e) {
    const result = {
      ...base,
      verdict: "error",
      serp: false,
      error: String(e?.message || e),
      elapsedMs: Date.now() - t0,
    };
    writeFileSync(join(caseDir, "CASE.json"), JSON.stringify(result, null, 2));
    console.error(`[case ${def.id}] ERROR ${result.error}`);
    return result;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!existsSync(join(REPO, "zig-out/bin/velora"))) {
    console.error("missing zig-out/bin/velora — run zig build first");
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stampRoot = ensureDir(join(OUT_ROOT, stamp));
  writeFileSync(join(OUT_ROOT, "LATEST"), stamp + "\n");

  let defs = [];
  if (args.wave === "live") defs = liveCaseDefs();
  else if (args.wave === "all") defs = [...savedCaseDefs(), ...liveCaseDefs()];
  else defs = savedCaseDefs();

  if (args.only?.length) {
    const set = new Set(args.only);
    defs = defs.filter((d) => set.has(d.id));
    // allow --only live-p45 without wave live
    if (!defs.length) {
      const live = liveCaseDefs().filter((d) => set.has(d.id));
      defs = live;
    }
    if (!defs.length) {
      console.error(`no cases match --only ${args.only.join(",")}`);
      process.exit(1);
    }
  }

  // Prefer likely SERP first when not filtering
  if (!args.only) {
    const order = [
      "warm-p45",
      "ok-p45",
      "live-p45",
      "live-p55",
      "live-p57",
      "profile55",
      "profile56",
      "live-p56",
      "fail-thin",
      "fake-thin",
      "empty",
    ];
    defs.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }

  console.log("=== Velora SERP case matrix ===");
  console.log(
    JSON.stringify(
      {
        stamp,
        wave: args.wave,
        concurrency: args.concurrency,
        maxSec: args.maxSec,
        q: args.q,
        cases: defs.map((d) => d.id),
        out: stampRoot,
      },
      null,
      2,
    ),
  );

  let winner = null;
  const results = await mapPool(defs, args.concurrency, async (def, _idx, requestStop) => {
    if (winner && !args.noStop) return null;
    const r = await runCase(def, args, stampRoot);
    if (r.serp && !winner) {
      winner = r;
      if (!args.noStop) {
        console.log(`\n[STOP] SERP achieved on case=${r.id} — cancelling remaining queue`);
        requestStop();
      }
    }
    return r;
  });

  const summary = {
    stamp,
    q: args.q,
    wave: args.wave,
    winner: winner
      ? { id: winner.id, verdict: winner.verdict, htmlLen: winner.htmlLen, results: winner.results }
      : null,
    results: results.map((r) => ({
      id: r.id,
      verdict: r.verdict,
      serp: r.serp,
      htmlLen: r.htmlLen,
      results: r.results,
      jarTotal: r.jarSummary?.total,
      elapsedMs: r.elapsedMs,
      error: r.error,
    })),
    out: stampRoot,
  };
  writeFileSync(join(stampRoot, "MATRIX.json"), JSON.stringify(summary, null, 2));
  writeFileSync(
    join(stampRoot, "SUMMARY.txt"),
    [
      `winner=${winner?.id ?? "NONE"}`,
      ...summary.results.map(
        (r) =>
          `${r.id}\t${r.verdict}\thtmlLen=${r.htmlLen}\tjar=${r.jarTotal}\t${r.elapsedMs}ms`,
      ),
      `out=${stampRoot}`,
    ].join("\n") + "\n",
  );

  console.log("\n=== MATRIX ===");
  console.log(JSON.stringify(summary, null, 2));

  if (winner) {
    console.log(`\n=== SERP OK: ${winner.id} ===`);
    process.exit(0);
  }

  // wave all: if saved failed, try live once more when wave was saved-only with --retry-live? handled by wave=all
  if (args.wave === "saved") {
    console.log(
      "\nNo SERP on saved jars. Next: node scripts/velora-serp-case-matrix.mjs --wave live",
    );
  }
  process.exit(2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
