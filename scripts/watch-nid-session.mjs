#!/usr/bin/env node
/**
 * Watch Google cookie/NID lifecycle in a Velora (or Chrome) session.
 *
 * Three milestones:
 *   t0  before any navigation
 *   t1  after https://www.google.com/
 *   t2  after https://www.google.com/search?q=…
 *
 * Usage:
 *   node scripts/watch-nid-session.mjs
 *   node scripts/watch-nid-session.mjs --profile velora58-watch --q velora
 *   node scripts/watch-nid-session.mjs --create-profile --profile my-watch
 *   node scripts/watch-nid-session.mjs --engine chrome   # true-cold Chrome temp
 *   node scripts/watch-nid-session.mjs --cookie-jar path/Cookies.json
 *   node scripts/watch-nid-session.mjs --out code-check/tmp/nid-watch
 *
 * On tier=serp at t2, writes Cookies-serp.json under --out.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const WebSocket = require(join(REPO, "node_modules/ws"));

const VELORA = process.env.VELORA_BIN ?? join(REPO, "zig-out/bin/velora");
const CHROME =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const DEFAULT_TEMPLATE = "chrome-local-huys-macbook-pro";

function parseArgs(argv) {
  const out = {
    engine: "velora", // velora | chrome
    profile: `nid-watch-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}`,
    createProfile: false,
    template: DEFAULT_TEMPLATE,
    q: "velora",
    cookieJar: null,
    out: join(REPO, "code-check/tmp/nid-watch"),
    homeWaitMs: 3500,
    searchWaitMs: 5000,
    maxSec: 60,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--engine") out.engine = argv[++i] ?? out.engine;
    else if (a === "--profile") out.profile = argv[++i] ?? out.profile;
    else if (a === "--create-profile") out.createProfile = true;
    else if (a === "--template") out.template = argv[++i] ?? out.template;
    else if (a === "--q" || a === "--query") out.q = argv[++i] ?? out.q;
    else if (a === "--cookie-jar") out.cookieJar = argv[++i] ?? out.cookieJar;
    else if (a === "--out") out.out = resolve(argv[++i] ?? out.out);
    else if (a === "--home-wait-ms") out.homeWaitMs = Number(argv[++i] ?? out.homeWaitMs);
    else if (a === "--search-wait-ms") out.searchWaitMs = Number(argv[++i] ?? out.searchWaitMs);
    else if (a === "--max-sec") out.maxSec = Number(argv[++i] ?? out.maxSec);
    else if (a === "--help" || a === "-h") {
      console.log(`Usage: node scripts/watch-nid-session.mjs [options]
  --engine velora|chrome   default velora
  --profile <id>           Velora profile name
  --create-profile         create profile if missing (template default chrome-local-huys-macbook-pro)
  --template <id>          template for create
  --q <query>              search query (default velora)
  --cookie-jar <path>      seed Cookies.json (omit for empty)
  --out <dir>              output directory
  --home-wait-ms N
  --search-wait-ms N
  --max-sec N`);
      process.exit(0);
    }
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 20000) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const o = { id, method, params };
      if (sessionId) o.sessionId = sessionId;
      this.ws.send(JSON.stringify(o));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`timeout ${method}`));
        }
      }, timeoutMs);
    });
  }
  async eval(expr, sessionId, retries = 12) {
    let last;
    for (let i = 0; i < retries; i++) {
      try {
        return await this.send(
          "Runtime.evaluate",
          { expression: expr, returnByValue: true, awaitPromise: true },
          sessionId,
          12000,
        );
      } catch (e) {
        last = e;
        if (/execution context|timeout Runtime|navigated|session with given id/i.test(String(e))) {
          await sleep(300);
          continue;
        }
        throw e;
      }
    }
    throw last;
  }
}

async function waitHttp(url, ms = 15000) {
  const d = Date.now() + ms;
  while (Date.now() < d) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {}
    await sleep(80);
  }
  return false;
}

function classify(html, href) {
  const h = html || "";
  const u = href || "";
  const knitsail = /knitsail/i.test(h);
  const rso = /id=["']rso["']/.test(h) || /id=["']search["']/.test(h);
  const sorry =
    /\/sorry/i.test(u) ||
    (/\/sorry/.test(h.slice(0, 8000)) &&
      /captcha|unusual traffic|Our systems have detected/i.test(h.slice(0, 20000)));
  let tier = "other";
  if (sorry) tier = "sorry";
  else if (rso && !knitsail && h.length > 200000) tier = "serp";
  else if (knitsail) tier = "knitsail";
  else if (h.length > 200000 && !knitsail) tier = "serp?";
  return { tier, htmlLen: h.length, knitsail, rso, sorry, href: u };
}

function cookieSummary(cookies) {
  const all = cookies || [];
  const g = all.filter((c) => /google/i.test(c.domain || ""));
  const byName = Object.fromEntries(
    g.map((c) => [c.name, { len: String(c.value || "").length, domain: c.domain }]),
  );
  const nid = g.find((c) => c.name === "NID");
  return {
    total: all.length,
    google: g.length,
    names: g.map((c) => c.name),
    nidLen: nid ? String(nid.value || "").length : 0,
    hasSG_SS: g.some((c) => c.name === "SG_SS"),
    hasDV: g.some((c) => c.name === "DV"),
    hasAEC: g.some((c) => c.name === "AEC"),
    detail: g.map((c) => `${c.name}(${String(c.value || "").length}@${c.domain})`),
    byName,
  };
}

function toVeloraJar(cookies) {
  return (cookies || [])
    .filter((c) => /google/i.test(c.domain || ""))
    .map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path || "/",
      expires: c.expires && c.expires > 0 ? c.expires : undefined,
      expirationDate: c.expires && c.expires > 0 ? c.expires : undefined,
      httpOnly: !!c.httpOnly,
      secure: !!c.secure,
      sameSite: c.sameSite || "None",
      session: !c.expires || c.expires <= 0,
    }));
}

function ensureVeloraProfile(args) {
  const profDir = join(homedir(), "Library/Application Support/velora", args.profile);
  const pref = join(profDir, "Preferences.json");
  if (existsSync(pref) && !args.createProfile) return;
  if (!existsSync(VELORA)) {
    console.error("velora binary missing:", VELORA);
    process.exit(2);
  }
  console.log(`[profile] create ${args.profile} template=${args.template}`);
  const r = spawnSync(
    VELORA,
    ["profile", "create", "--name", args.profile, "--template", args.template],
    { encoding: "utf8" },
  );
  if (r.status !== 0 && !existsSync(pref)) {
    console.error(r.stdout || "", r.stderr || "");
    process.exit(r.status || 2);
  }
  // keep clean unless cookie-jar provided
  if (!args.cookieJar) {
    try {
      rmSync(join(profDir, "Cookies.json"));
    } catch {}
  }
}

async function attachPage(endpoint) {
  const ver = await (await fetch(`${endpoint}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  const cdp = new Cdp(ws);
  const created = await cdp.send("Target.createTarget", { url: "about:blank" });
  const att = await cdp.send("Target.attachToTarget", {
    targetId: created.targetId,
    flatten: true,
  });
  const sid = att.sessionId;
  await cdp.send("Page.enable", {}, sid);
  await cdp.send("Runtime.enable", {}, sid);
  await cdp.send("Network.enable", {}, sid);
  return { cdp, ws, sid, ver };
}

async function getCookies(cdp, sid) {
  try {
    const r = await cdp.send("Network.getAllCookies", {}, sid);
    return r.cookies || [];
  } catch {
    const r = await cdp.send("Network.getAllCookies", {});
    return r.cookies || [];
  }
}

async function pageSnap(cdp, sid) {
  const s = await cdp.eval(
    `(() => {
      const html = document.documentElement ? document.documentElement.outerHTML : '';
      return {
        href: location.href,
        title: document.title,
        ready: document.readyState,
        htmlLen: html.length,
        knitsail: /knitsail/i.test(html),
        rso: !!document.querySelector('#rso, #search'),
        hasH3: document.querySelectorAll('#rso h3, #search h3').length,
        sorry: /\\/sorry/i.test(location.href),
        html,
      };
    })()`,
    sid,
  );
  return s?.result?.value;
}

function printMilestone(label, m) {
  const line = {
    t: label,
    cookies: m.cookies?.detail?.join(", ") || "(none)",
    nidLen: m.cookies?.nidLen ?? 0,
    hasSG_SS: m.cookies?.hasSG_SS,
    hasDV: m.cookies?.hasDV,
    tier: m.page?.tier,
    htmlLen: m.page?.htmlLen,
    rso: m.page?.rso,
    knitsail: m.page?.knitsail,
    sorry: m.page?.sorry,
    href: (m.page?.href || "").slice(0, 100),
  };
  console.log(
    `\n── ${label} ──\n` +
      `  nidLen=${line.nidLen}  cookies=[${line.cookies}]\n` +
      `  SG_SS=${line.hasSG_SS}  DV=${line.hasDV}\n` +
      `  tier=${line.tier}  htmlLen=${line.htmlLen}  rso=${line.rso}  knitsail=${line.knitsail}  sorry=${line.sorry}\n` +
      `  href=${line.href}`,
  );
  return line;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(args.out, { recursive: true });
  const t0wall = Date.now();
  const HOME_URL = "https://www.google.com/?hl=en";
  const SEARCH_URL = `https://www.google.com/search?q=${encodeURIComponent(args.q)}&hl=en`;

  const report = {
    ts: new Date().toISOString(),
    engine: args.engine,
    profile: args.profile,
    q: args.q,
    cookieJar: args.cookieJar,
    milestones: {},
  };

  console.log("[watch-nid] start", {
    engine: args.engine,
    profile: args.profile,
    q: args.q,
    jar: args.cookieJar,
    out: args.out,
  });

  let proc;
  let kill = () => {};
  let endpoint;
  let chromeUd = null;

  if (args.engine === "chrome") {
    const port = await freePort();
    chromeUd = join(tmpdir(), `velora-nid-watch-chrome-${port}`);
    try {
      rmSync(chromeUd, { recursive: true, force: true });
    } catch {}
    mkdirSync(chromeUd, { recursive: true });
    proc = spawn(
      CHROME,
      [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${chromeUd}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "about:blank",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    endpoint = `http://127.0.0.1:${port}`;
    kill = () => {
      try {
        proc.kill("SIGKILL");
      } catch {}
      try {
        rmSync(chromeUd, { recursive: true, force: true });
      } catch {}
    };
  } else {
    ensureVeloraProfile({ ...args, createProfile: args.createProfile || true });
    if (args.cookieJar && existsSync(args.cookieJar)) {
      const dest = join(
        homedir(),
        "Library/Application Support/velora",
        args.profile,
        "Cookies.json",
      );
      writeFileSync(dest, readFileSync(args.cookieJar));
      console.log("[watch-nid] seeded jar →", dest);
    }
    const port = await freePort();
    const vargs = [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--browser-profile",
      args.profile,
      "--log-level",
      "info",
    ];
    if (args.cookieJar && existsSync(args.cookieJar)) {
      vargs.push("--cookie-jar", args.cookieJar);
    }
    proc = spawn(VELORA, vargs, {
      cwd: REPO,
      stdio: ["ignore", "pipe", "pipe"],
    });
    endpoint = `http://127.0.0.1:${port}`;
    kill = () => {
      try {
        proc.kill("SIGKILL");
      } catch {}
    };
  }

  let stderr = "";
  proc.stderr?.on("data", (d) => {
    stderr += d.toString();
  });
  let exitInfo = null;
  proc.on("exit", (code, sig) => {
    exitInfo = { code, sig };
  });

  const watchdog = setTimeout(() => {
    console.error("[watch-nid] HARD TIMEOUT", args.maxSec);
    report.hang = true;
    writeFileSync(join(args.out, "REPORT.json"), JSON.stringify(report, null, 2));
    kill();
    process.exit(3);
  }, args.maxSec * 1000);

  try {
    if (!(await waitHttp(`${endpoint}/json/version`, 20000))) {
      throw new Error("CDP not ready: " + stderr.slice(-800));
    }
    const { cdp, ws, sid } = await attachPage(endpoint);

    // ── t0 ──
    let cookies = await getCookies(cdp, sid);
    let page = null;
    report.milestones.t0_before = {
      cookies: cookieSummary(cookies),
      page: null,
      ms: Date.now() - t0wall,
    };
    printMilestone("t0 before any nav", report.milestones.t0_before);
    writeFileSync(join(args.out, "cookies-t0.json"), JSON.stringify(cookies, null, 2));

    // ── t1 home ──
    console.log("\n[nav] home", HOME_URL);
    await cdp.send("Page.navigate", { url: HOME_URL }, sid);
    await sleep(args.homeWaitMs);
    try {
      page = await pageSnap(cdp, sid);
    } catch (e) {
      page = { err: String(e) };
    }
    cookies = await getCookies(cdp, sid);
    const homeCls = classify(page?.html || "", page?.href);
    report.milestones.t1_after_home = {
      cookies: cookieSummary(cookies),
      page: { ...homeCls, title: page?.title, ready: page?.ready, hasH3: page?.hasH3 },
      ms: Date.now() - t0wall,
    };
    printMilestone("t1 after home", report.milestones.t1_after_home);
    writeFileSync(join(args.out, "cookies-t1-home.json"), JSON.stringify(cookies, null, 2));
    if (page?.html) writeFileSync(join(args.out, "page-t1-home.html"), page.html.slice(0, 400000));
    writeFileSync(
      join(args.out, "Cookies-after-home.json"),
      JSON.stringify(toVeloraJar(cookies), null, 2),
    );

    // ── t2 search ──
    console.log("\n[nav] search", SEARCH_URL);
    await cdp.send("Page.navigate", { url: SEARCH_URL }, sid);
    let snap = null;
    const searchDeadline = Date.now() + args.searchWaitMs + 4000;
    for (let i = 0; i < 20 && !exitInfo && Date.now() < searchDeadline; i++) {
      await sleep(400);
      try {
        snap = await pageSnap(cdp, sid);
        if (
          snap?.sorry ||
          (snap?.rso && snap.hasH3 > 0) ||
          (snap?.knitsail && i >= 4) ||
          (snap?.htmlLen > 200000 && i >= 2)
        ) {
          if (i >= 2) break;
        }
      } catch (e) {
        console.log(`[search poll ${i + 1}]`, String(e).slice(0, 100));
      }
    }
    if (!exitInfo) {
      try {
        cookies = await getCookies(cdp, sid);
      } catch {}
    }
    const searchCls = classify(snap?.html || "", snap?.href);
    report.milestones.t2_after_search = {
      cookies: cookieSummary(cookies),
      page: {
        ...searchCls,
        title: snap?.title,
        ready: snap?.ready,
        hasH3: snap?.hasH3,
      },
      crashed: !!exitInfo,
      exitInfo,
      ms: Date.now() - t0wall,
    };
    printMilestone("t2 after search", report.milestones.t2_after_search);
    writeFileSync(join(args.out, "cookies-t2-search.json"), JSON.stringify(cookies, null, 2));
    if (snap?.html) writeFileSync(join(args.out, "page-t2-search.html"), snap.html.slice(0, 800000));

    const jarFinal = toVeloraJar(cookies);
    writeFileSync(join(args.out, "Cookies-after-search.json"), JSON.stringify(jarFinal, null, 2));

    const tier = searchCls.tier;
    report.ok = tier === "serp" || tier === "serp?";
    report.totalMs = Date.now() - t0wall;
    report.nidDelta = {
      t0: report.milestones.t0_before.cookies.nidLen,
      t1: report.milestones.t1_after_home.cookies.nidLen,
      t2: report.milestones.t2_after_search.cookies.nidLen,
      grewHomeToSearch:
        report.milestones.t2_after_search.cookies.nidLen -
        report.milestones.t1_after_home.cookies.nidLen,
    };

    if (report.ok) {
      const serpJar = join(args.out, "Cookies-serp.json");
      writeFileSync(serpJar, JSON.stringify(jarFinal, null, 2));
      console.log("\n[watch-nid] SERP — saved", serpJar);
      // also into profile if velora
      if (args.engine === "velora") {
        const dest = join(
          homedir(),
          "Library/Application Support/velora",
          args.profile,
          "Cookies.json",
        );
        writeFileSync(dest, JSON.stringify(jarFinal, null, 2));
        console.log("[watch-nid] also wrote profile jar", dest);
      }
    }

    // compact table
    console.log("\n======== NID WATCH TABLE ========");
    console.log(
      "milestone".padEnd(18),
      "nidLen".padStart(7),
      "tier".padEnd(10),
      "htmlLen".padStart(8),
      "SG_SS".padStart(6),
      "DV".padStart(4),
    );
    for (const [k, m] of Object.entries(report.milestones)) {
      console.log(
        k.padEnd(18),
        String(m.cookies?.nidLen ?? 0).padStart(7),
        String(m.page?.tier ?? "-").padEnd(10),
        String(m.page?.htmlLen ?? 0).padStart(8),
        String(!!m.cookies?.hasSG_SS).padStart(6),
        String(!!m.cookies?.hasDV).padStart(4),
      );
    }
    console.log(
      "\nnidDelta t0→t1→t2:",
      report.nidDelta.t0,
      "→",
      report.nidDelta.t1,
      "→",
      report.nidDelta.t2,
      `(search-home Δ=${report.nidDelta.grewHomeToSearch})`,
    );
    console.log("result:", report.ok ? "SERP OK" : `tier=${tier}`, `totalMs=${report.totalMs}`);

    writeFileSync(join(args.out, "REPORT.json"), JSON.stringify(report, null, 2));
    writeFileSync(join(args.out, "stderr-tail.txt"), stderr.slice(-8000));
    writeFileSync(join(args.out, "SUMMARY.txt"), [
      `engine=${args.engine} profile=${args.profile} q=${args.q}`,
      `t0 nidLen=${report.nidDelta.t0}`,
      `t1 nidLen=${report.nidDelta.t1} tier=${report.milestones.t1_after_home.page?.tier}`,
      `t2 nidLen=${report.nidDelta.t2} tier=${tier} htmlLen=${searchCls.htmlLen} SG_SS=${report.milestones.t2_after_search.cookies.hasSG_SS}`,
      `ok=${report.ok} totalMs=${report.totalMs}`,
      "",
    ].join("\n"));

    try {
      ws.close();
    } catch {}
    clearTimeout(watchdog);
    kill();
    process.exit(report.ok ? 0 : 1);
  } catch (e) {
    console.error("[watch-nid] error", e);
    report.error = String(e?.stack || e);
    report.stderr = stderr.slice(-4000);
    writeFileSync(join(args.out, "REPORT.json"), JSON.stringify(report, null, 2));
    clearTimeout(watchdog);
    kill();
    process.exit(2);
  }
}

main();
