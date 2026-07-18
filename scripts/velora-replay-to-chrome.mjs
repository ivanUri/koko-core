#!/usr/bin/env node
/**
 * Reverse A/B: import Velora Google-search surface (cookies + URL) into real Chrome
 * via CDP, navigate, classify SERP tier, and interpret state-vs-stack.
 *
 * Does NOT import TLS/header order (Chrome rebuilds those). That is intentional:
 * if Chrome still knitsails with Velora's jar → state/IP; if Chrome SERPs → stack gap.
 *
 * Usage:
 *   node scripts/velora-replay-to-chrome.mjs --from code-check/google-search-ab/runs/<stamp>/fail
 *   node scripts/velora-replay-to-chrome.mjs --from .../ok --q "velora browser"
 *   node scripts/velora-replay-to-chrome.mjs --jar path/Cookies.json --url 'https://www.google.com/search?q=velora'
 *   node scripts/velora-replay-to-chrome.mjs --empty --q velora
 *   node scripts/velora-replay-to-chrome.mjs --from .../fail --keep-chrome   # leave Chrome open
 *
 * Env:
 *   CHROME_BIN          path to Google Chrome binary
 *   CHROME_CDP          if set, connect only (do not spawn); no cookie clear safety net across profiles
 *   VELORA_REPLAY_OUT   output dir (default code-check/tmp/velora-replay-to-chrome)
 *
 * Budget: --max-sec (default 25). Hard kill spawned Chrome on hang → exit 3.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, homedir } from "node:os";
import WebSocket from "ws";
import {
  createProbeBudget,
  killProcess,
  parseMaxSecArg,
  waitCdp,
  remainingMs,
  HANG_EXIT_CODE,
} from "./lib/cdp-probe-budget.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const DEFAULT_OUT = join(REPO, "code-check/tmp/velora-replay-to-chrome");

const EXTRACT = `(() => {
  const text = (document.body && document.body.innerText) || '';
  const html = document.documentElement ? document.documentElement.outerHTML : '';
  const href = location.href;
  const lower = (text + ' ' + href + ' ' + html.slice(0, 80000)).toLowerCase();
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const results = qa('#search a h3, #rso h3, div.g h3, a h3').slice(0, 12).map((h) => {
    const a = h.closest('a') || h.parentElement?.closest?.('a');
    return { title: (h.textContent || '').trim().slice(0, 140), href: a?.href || null };
  });
  return {
    href,
    title: document.title || '',
    readyState: document.readyState,
    bodyLen: text.length,
    htmlLen: html.length,
    signals: {
      sorry: href.includes('/sorry') || lower.includes('unusual traffic') || lower.includes('detected unusual traffic'),
      knitsail: html.includes('knitsail') || html.includes('KGX') || lower.includes('knitsail'),
      enablejs: href.includes('enablejs') || lower.includes('enable javascript') || lower.includes('/httpservice/retry/enablejs'),
      consent: !!(q('form[action*="consent"]') || q('#L2AGLb') || lower.includes('before you continue')),
      recaptcha: !!(q('iframe[src*="recaptcha"]') || q('#recaptcha') || q('.g-recaptcha') || lower.includes('not a robot')),
      rso: !!(q('#rso') || q('#search') || q('#result-stats') || q('div.tF2Cxc')),
      searchBox: !!(q('textarea[name="q"]') || q('input[name="q"]')),
    },
    resultStats: (q('#result-stats')?.textContent || '').trim().slice(0, 200),
    results,
    bodyHead: text.replace(/\\s+/g, ' ').trim().slice(0, 500),
  };
})()`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultChromeBin() {
  if (process.env.CHROME_BIN && existsSync(process.env.CHROME_BIN)) {
    return process.env.CHROME_BIN;
  }
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0];
}

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

function parseArgs(argv) {
  const out = {
    from: null,
    jar: null,
    url: null,
    q: null,
    empty: false,
    maxSec: parseMaxSecArg(argv, 25),
    keepChrome: false,
    connectOnly: Boolean(process.env.CHROME_CDP),
    endpoint: process.env.CHROME_CDP || null,
    chromeBin: defaultChromeBin(),
    outDir: process.env.VELORA_REPLAY_OUT || DEFAULT_OUT,
    waitMs: 4000,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--from") out.from = argv[++i];
    else if (a === "--jar") out.jar = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--q" || a === "--query") out.q = argv[++i];
    else if (a === "--empty" || a === "--empty-jar") out.empty = true;
    else if (a === "--keep-chrome") out.keepChrome = true;
    else if (a === "--connect") {
      out.connectOnly = true;
      out.endpoint = argv[++i] || process.env.CHROME_CDP || "http://127.0.0.1:9222";
    }
    else if (a === "--chrome-bin") out.chromeBin = argv[++i];
    else if (a === "--out") out.outDir = argv[++i];
    else if (a === "--wait-ms") out.waitMs = Number(argv[++i] ?? out.waitMs);
    else if (a === "--max-sec") out.maxSec = Number(argv[++i] ?? out.maxSec);
  }
  return out;
}

function usage() {
  return `velora-replay-to-chrome — reverse A/B (Velora jar+URL → real Chrome)

Usage:
  node scripts/velora-replay-to-chrome.mjs --from <ab-lane-dir>
  node scripts/velora-replay-to-chrome.mjs --jar Cookies.json --q "velora browser"
  node scripts/velora-replay-to-chrome.mjs --empty --q velora

Options:
  --from DIR       google-search-ab lane (fail|ok|profile55-search|...) with Cookies.json
  --jar PATH       Velora Cookies.json (array of {name,value,domain,path,...})
  --url URL        exact search URL (else from wire-summary / snapshot / --q)
  --q QUERY        build https://www.google.com/search?q=...
  --empty          no cookies (clear Google cookies only)
  --max-sec N      hard budget (default 25); hang → kill Chrome, exit 3
  --wait-ms N      settle after navigate before poll (default 4000)
  --keep-chrome    do not kill spawned Chrome at end
  --connect URL    attach existing CDP (default CHROME_CDP); careful with cookies
  --chrome-bin P   Chrome executable
  --out DIR        write REPORT.json / page.json / html

Interprets Chrome verdict vs optional Velora snapshot.json in --from.`;
}

function resolvePath(p) {
  if (!p) return null;
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function summarizeJar(cookies) {
  const names = [...new Set(cookies.map((c) => c.name))].sort();
  return {
    total: cookies.length,
    names: names.slice(0, 50),
    hasSID: names.some((n) =>
      ["SID", "__Secure-1PSID", "HSID", "APISID", "SAPISID"].includes(n),
    ),
    hasNID: names.includes("NID"),
    hasAEC: names.includes("AEC"),
    hasSTRP: names.includes("__Secure-STRP"),
    hasSG_SS: names.includes("SG_SS"),
    nidLen: cookies.find((c) => c.name === "NID")?.value?.length ?? 0,
  };
}

function urlFromWireSummary(wirePath) {
  if (!existsSync(wirePath)) return null;
  try {
    const rows = loadJson(wirePath);
    const list = Array.isArray(rows) ? rows : [rows];
    const initial =
      list.find((r) => r.hop === "initial" && r.url?.includes("/search")) ||
      list.find((r) => r.url?.includes("google.") && r.url?.includes("/search"));
    return initial?.url || null;
  } catch {
    return null;
  }
}

function urlFromSnapshot(snapPath) {
  if (!existsSync(snapPath)) return null;
  try {
    const s = loadJson(snapPath);
    return s.href || null;
  } catch {
    return null;
  }
}

function veloraVerdictFromSnapshot(snap) {
  if (!snap) return null;
  const s = snap.signals || {};
  if (s.sorry || s.recaptcha) return "blocked_sorry_captcha";
  if (s.knitsail && !s.rso) return "knitsail_bootstrap";
  if (s.enablejs && !s.rso) return "soft_block_enablejs";
  if (s.rso || (snap.results?.length ?? 0) > 0) return "serp_ok";
  if ((snap.htmlLen ?? 0) > 5000) return "loaded_no_serp_markers";
  return "empty_or_incomplete";
}

function chromeVerdictOf(page) {
  const s = page?.signals || {};
  if (s.sorry || s.recaptcha) return "blocked_sorry_captcha";
  if (s.consent && !s.rso) return "consent_wall";
  if (s.knitsail && !s.rso) return "knitsail_bootstrap";
  if (s.enablejs && !s.rso) return "soft_block_enablejs";
  if (s.rso || (page?.results?.length ?? 0) > 0) return "serp_ok";
  if ((page?.htmlLen ?? 0) > 5000) return "loaded_no_serp_markers";
  return "empty_or_incomplete";
}

function interpret(veloraVerdict, chromeVerdict, jarSummary) {
  const V = veloraVerdict || "unknown";
  const C = chromeVerdict;
  const empty = !jarSummary || jarSummary.total === 0;

  if (V === "knitsail_bootstrap" && C === "knitsail_bootstrap") {
    return {
      cell: "V_knitsail_C_knitsail",
      meaning:
        "Same state fails on both stacks → cookie/session/IP reputation (or poisoned jar), not only Velora TLS.",
      priority: "P0_cookie_session_ip",
    };
  }
  if (V === "knitsail_bootstrap" && C === "serp_ok") {
    return {
      cell: "V_knitsail_C_serp",
      meaning:
        "Chrome stack rescues the same jar+URL → gap is TLS/H2/QUIC/browser stack (P1), not cookie text alone.",
      priority: "P1_stack_tls",
    };
  }
  if (V === "serp_ok" && C === "serp_ok") {
    return {
      cell: "V_serp_C_serp",
      meaning: "State is good enough for both paths.",
      priority: "none",
    };
  }
  if (V === "serp_ok" && C === "knitsail_bootstrap") {
    return {
      cell: "V_serp_C_knitsail",
      meaning:
        "Unexpected: Chrome worse than Velora — check cookie domain/path import, consent, or IP/time drift.",
      priority: "investigate_import",
    };
  }
  if (empty && C === "serp_ok") {
    return {
      cell: "empty_C_serp",
      meaning:
        "Cold Chrome 0-cookie can SERP → reinforces stack > empty jar (Velora empty often knitsails).",
      priority: "P1_stack_tls",
    };
  }
  if (empty && C === "knitsail_bootstrap") {
    return {
      cell: "empty_C_knitsail",
      meaning: "Even Chrome cold fails — IP/rate limit or Google experiment; not Velora-specific.",
      priority: "P0_ip_rate",
    };
  }
  return {
    cell: `V_${V}__C_${C}`,
    meaning: "See matrix in script header / google-search-ab README.",
    priority: "review",
  };
}

/** Map Velora Cookies.json → CDP Network.CookieParam */
function toCdpCookies(cookies) {
  const out = [];
  for (const c of cookies) {
    if (!c?.name || c.value == null) continue;
    const domain = String(c.domain || ".google.com");
    const path = String(c.path || "/");
    let sameSite = c.sameSite ?? c.same_site ?? "Lax";
    if (typeof sameSite === "string") {
      const s = sameSite.toLowerCase();
      if (s === "strict") sameSite = "Strict";
      else if (s === "lax") sameSite = "Lax";
      else if (s === "none" || s === "no_restriction") sameSite = "None";
      else sameSite = "Lax";
    }
    const param = {
      name: String(c.name),
      value: String(c.value),
      domain,
      path,
      secure: Boolean(
        c.secure ?? (domain.startsWith(".") || String(c.name).startsWith("__Secure")),
      ),
      httpOnly: Boolean(c.httpOnly ?? c.http_only ?? false),
      sameSite,
    };
    // Velora uses unix seconds in `expires`; CDP uses Time since epoch seconds.
    let exp = c.expires ?? c.expirationDate ?? c.expiry;
    if (typeof exp === "string" && exp) exp = Number(exp);
    if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) {
      // ms → s
      if (exp > 1e12) exp = exp / 1000;
      param.expires = exp;
    }
    out.push(param);
  }
  return out;
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
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

function loadInputs(args) {
  const fromDir = resolvePath(args.from);
  let cookies = [];
  let jarPath = null;
  let searchUrl = args.url || null;
  let veloraSnapshot = null;
  let veloraSnapshotPath = null;
  let wirePath = null;

  if (fromDir) {
    if (!existsSync(fromDir)) throw new Error(`--from not found: ${fromDir}`);
    const candidates = [
      join(fromDir, "Cookies.json"),
      join(fromDir, "cookies-jar-before.json"),
    ];
    for (const p of candidates) {
      if (existsSync(p)) {
        jarPath = p;
        break;
      }
    }
    wirePath = join(fromDir, "wire-summary.json");
    const snap = join(fromDir, "snapshot.json");
    if (existsSync(snap)) {
      veloraSnapshotPath = snap;
      veloraSnapshot = loadJson(snap);
    }
    if (!searchUrl) searchUrl = urlFromWireSummary(wirePath);
    if (!searchUrl) searchUrl = urlFromSnapshot(snap);
  }

  if (args.jar) {
    jarPath = resolvePath(args.jar);
  }

  if (args.empty) {
    cookies = [];
    jarPath = jarPath || "(empty)";
  } else if (jarPath && jarPath !== "(empty)") {
    if (!existsSync(jarPath)) throw new Error(`jar not found: ${jarPath}`);
    const raw = loadJson(jarPath);
    if (!Array.isArray(raw)) throw new Error(`jar must be JSON array: ${jarPath}`);
    cookies = raw;
  } else if (!fromDir) {
    // default: try latest fail lane if present
    const latestPath = join(REPO, "code-check/google-search-ab/runs/LATEST");
    if (existsSync(latestPath)) {
      const stamp = readFileSync(latestPath, "utf8").trim();
      const failDir = join(REPO, "code-check/google-search-ab/runs", stamp, "fail");
      if (existsSync(join(failDir, "Cookies.json"))) {
        return loadInputs({ ...args, from: failDir });
      }
    }
    throw new Error("Need --from DIR, --jar PATH, or --empty");
  }

  if (!searchUrl && args.q) {
    searchUrl = `https://www.google.com/search?q=${encodeURIComponent(args.q)}&hl=en`;
  }
  if (!searchUrl && veloraSnapshot?.href) {
    searchUrl = veloraSnapshot.href;
  }
  if (!searchUrl) {
    searchUrl = "https://www.google.com/search?q=velora&hl=en";
  }

  return {
    fromDir,
    jarPath,
    cookies,
    searchUrl,
    veloraSnapshot,
    veloraSnapshotPath,
    wirePath,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }

  const inputs = loadInputs(args);
  const jarSummary = summarizeJar(inputs.cookies);
  const cdpCookies = toCdpCookies(inputs.cookies);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(resolvePath(args.outDir) || DEFAULT_OUT, stamp);
  mkdirSync(outDir, { recursive: true });

  let chromeProc = null;
  let userDataDir = null;
  let endpoint = args.endpoint;

  const cleanup = ({ reason } = {}) => {
    if (args.keepChrome && reason !== "hang") {
      console.error(`[chrome] keep-chrome: leaving process (user-data-dir=${userDataDir})`);
      return;
    }
    killProcess(chromeProc, "SIGKILL");
    chromeProc = null;
    if (userDataDir && !args.keepChrome) {
      try {
        rmSync(userDataDir, { recursive: true, force: true });
      } catch {}
    }
  };

  const budget = createProbeBudget(args.maxSec, cleanup);

  console.log("=== Velora → Chrome reverse replay ===");
  console.log(`from=${inputs.fromDir || "(none)"}`);
  console.log(`jar=${inputs.jarPath} total=${jarSummary.total}`);
  console.log(`url=${inputs.searchUrl}`);
  console.log(`maxSec=${args.maxSec} out=${outDir}`);
  console.log(`[jar] ${JSON.stringify(jarSummary)}`);

  try {
    if (!args.connectOnly) {
      if (!existsSync(args.chromeBin)) {
        throw new Error(
          `Chrome binary not found: ${args.chromeBin}\nSet CHROME_BIN or install Google Chrome.`,
        );
      }
      const port = await freePort();
      endpoint = `http://127.0.0.1:${port}`;
      userDataDir = join(tmpdir(), `velora-replay-chrome-${process.pid}-${port}`);
      mkdirSync(userDataDir, { recursive: true });
      console.log(`[chrome] spawn ${args.chromeBin}`);
      console.log(`[chrome] cdp=${endpoint} userDataDir=${userDataDir}`);
      chromeProc = spawn(
        args.chromeBin,
        [
          `--remote-debugging-port=${port}`,
          `--user-data-dir=${userDataDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-default-apps",
          "--disable-sync",
          "--disable-background-networking",
          "--disable-popup-blocking",
          "--disable-hang-monitor",
          "--password-store=basic",
          "--use-mock-keychain",
          "about:blank",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env },
        },
      );
      let chromeErr = "";
      chromeProc.stderr?.on("data", (d) => {
        chromeErr += String(d);
        if (chromeErr.length > 4000) chromeErr = chromeErr.slice(-4000);
      });
      chromeProc.on("exit", (code, signal) => {
        if (code && code !== 0) {
          console.error(`[chrome] exited code=${code} signal=${signal}`);
        }
      });
      try {
        await waitCdp(endpoint, budget.deadline);
      } catch (e) {
        console.error(chromeErr.slice(-800));
        budget.failHang("chrome_cdp_ready", String(e?.message || e));
      }
    } else {
      endpoint = String(endpoint || "http://127.0.0.1:9222").replace(/\/$/, "");
      console.log(`[chrome] connect-only ${endpoint}`);
      try {
        await waitCdp(endpoint, budget.deadline);
      } catch (e) {
        budget.failHang("chrome_cdp_ready", String(e?.message || e));
      }
    }

    const version = await (
      await fetch(`${endpoint}/json/version`, {
        signal: AbortSignal.timeout(Math.min(3000, budget.remaining())),
      })
    ).json();
    const browserUA = version["User-Agent"] || version.Browser || null;
    console.log(`[chrome] ${browserUA || version.webSocketDebuggerUrl}`);

    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
      setTimeout(() => rej(new Error("ws open timeout")), Math.min(10000, budget.remaining()));
    });
    const client = new Cdp(ws);

    let page = null;
    let cookiesAfter = [];
    let cookiesBeforeNav = [];

    try {
      await client.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
      const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await client.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      await client.send("Page.enable", {}, sessionId);
      await client.send("Runtime.enable", {}, sessionId);
      await client.send("Network.enable", {}, sessionId);

      // Isolate cookie jar for this temp profile (spawn path). On connect-only,
      // still clear all browser cookies so replay is not polluted by live profile.
      await client.send("Network.clearBrowserCookies", {}, sessionId).catch(() => {});
      // Extra: delete google cookies if any remain
      try {
        const existing = await client.send("Network.getAllCookies", {}, sessionId);
        const google = (existing.cookies || []).filter((c) =>
          String(c.domain || "").includes("google."),
        );
        for (const c of google) {
          await client
            .send(
              "Network.deleteCookies",
              {
                name: c.name,
                domain: c.domain,
                path: c.path,
              },
              sessionId,
            )
            .catch(() => {});
        }
      } catch {}

      if (cdpCookies.length) {
        const setRes = await client.send(
          "Network.setCookies",
          { cookies: cdpCookies },
          sessionId,
          15000,
        );
        console.log(`[cookies] setCookies success=${setRes?.success !== false} count=${cdpCookies.length}`);
      } else {
        console.log("[cookies] empty jar — navigating cold");
      }

      const allBefore = await client.send("Network.getAllCookies", {}, sessionId);
      cookiesBeforeNav = (allBefore.cookies || []).filter((c) =>
        String(c.domain || "").includes("google"),
      );
      console.log(`[cookies] before nav google count=${cookiesBeforeNav.length}`);

      console.log(`[nav] ${inputs.searchUrl}`);
      try {
        await client.send(
          "Page.navigate",
          { url: inputs.searchUrl },
          sessionId,
          Math.min(20000, budget.remaining()),
        );
      } catch (e) {
        console.log(`[nav] navigate: ${e.message}`);
      }

      const waitMs = Math.min(args.waitMs, budget.remaining());
      if (waitMs > 0) await delay(waitMs);

      let last = null;
      for (let i = 0; i < 16; i += 1) {
        if (budget.remaining() < 1500) break;
        await delay(Math.min(500, budget.remaining()));
        try {
          const r = await client.send(
            "Runtime.evaluate",
            { expression: EXTRACT, returnByValue: true },
            sessionId,
            Math.min(10000, budget.remaining()),
          );
          last = r.result?.value;
          const s = last?.signals || {};
          if (
            s.rso ||
            s.sorry ||
            s.knitsail ||
            s.recaptcha ||
            s.enablejs ||
            s.consent ||
            (last?.htmlLen ?? 0) > 8000
          ) {
            break;
          }
        } catch (e) {
          console.log(`[poll] ${e.message}`);
        }
      }
      page = last;

      try {
        const htmlRes = await client.send(
          "Runtime.evaluate",
          {
            expression:
              "document.documentElement ? document.documentElement.outerHTML : ''",
            returnByValue: true,
          },
          sessionId,
          Math.min(10000, budget.remaining()),
        );
        const html = htmlRes.result?.value || "";
        if (html) writeFileSync(join(outDir, "page.html"), html);
      } catch {}

      try {
        const allAfter = await client.send("Network.getAllCookies", {}, sessionId);
        cookiesAfter = (allAfter.cookies || []).filter((c) =>
          String(c.domain || "").includes("google"),
        );
      } catch {}

      await client.send("Target.closeTarget", { targetId }).catch(() => {});
    } finally {
      client.close();
    }

    const chromeVerdict = chromeVerdictOf(page);
    const veloraVerdict = veloraVerdictFromSnapshot(inputs.veloraSnapshot);
    const interpretation = interpret(veloraVerdict, chromeVerdict, jarSummary);

    const report = {
      stamp,
      mode: "velora_jar_url_to_chrome",
      inputs: {
        from: inputs.fromDir,
        jarPath: inputs.jarPath,
        searchUrl: inputs.searchUrl,
        empty: args.empty || jarSummary.total === 0,
        connectOnly: args.connectOnly,
      },
      jarSummary,
      chrome: {
        endpoint,
        userAgent: browserUA,
        binary: args.connectOnly ? null : args.chromeBin,
      },
      cookies: {
        imported: cdpCookies.length,
        beforeNavGoogle: cookiesBeforeNav.map((c) => ({
          name: c.name,
          domain: c.domain,
          path: c.path,
          valueLen: (c.value || "").length,
        })),
        afterNavGoogle: cookiesAfter.map((c) => ({
          name: c.name,
          domain: c.domain,
          path: c.path,
          valueLen: (c.value || "").length,
        })),
      },
      velora: {
        snapshotPath: inputs.veloraSnapshotPath,
        verdict: veloraVerdict,
        snapshot: inputs.veloraSnapshot
          ? {
              href: inputs.veloraSnapshot.href,
              title: inputs.veloraSnapshot.title,
              htmlLen: inputs.veloraSnapshot.htmlLen,
              signals: inputs.veloraSnapshot.signals,
              resultsCount: inputs.veloraSnapshot.results?.length ?? 0,
            }
          : null,
      },
      chromePage: page,
      chromeVerdict,
      interpretation,
      notes: [
        "Headers/TLS not imported — Chrome rebuilds wire fingerprint.",
        "Compare chromeVerdict vs velora.verdict for state-vs-stack cell.",
      ],
    };

    writeFileSync(join(outDir, "REPORT.json"), JSON.stringify(report, null, 2));
    writeFileSync(join(outDir, "page.json"), JSON.stringify(page, null, 2));
    writeFileSync(
      join(outDir, "cookies-imported.json"),
      JSON.stringify(inputs.cookies, null, 2),
    );
    writeFileSync(
      join(outDir, "SUMMARY.txt"),
      [
        `velora_verdict=${veloraVerdict ?? "n/a"}`,
        `chrome_verdict=${chromeVerdict}`,
        `cell=${interpretation.cell}`,
        `priority=${interpretation.priority}`,
        `meaning=${interpretation.meaning}`,
        `jar_total=${jarSummary.total}`,
        `url=${inputs.searchUrl}`,
        `htmlLen=${page?.htmlLen ?? 0}`,
        `results=${page?.results?.length ?? 0}`,
        `out=${outDir}`,
      ].join("\n") + "\n",
    );

    // latest pointer
    writeFileSync(
      join(dirname(outDir), "LATEST"),
      stamp + "\n",
    );

    console.log("\n=== Result ===");
    console.log(
      JSON.stringify(
        {
          veloraVerdict,
          chromeVerdict,
          cell: interpretation.cell,
          priority: interpretation.priority,
          meaning: interpretation.meaning,
          href: page?.href,
          title: page?.title,
          htmlLen: page?.htmlLen,
          signals: page?.signals,
          results: page?.results?.length ?? 0,
          out: outDir,
        },
        null,
        2,
      ),
    );

    budget.clear();
    cleanup();
    process.exit(0);
  } catch (err) {
    console.error("[error]", err?.message || err);
    writeFileSync(
      join(outDir, "ERROR.json"),
      JSON.stringify({ error: String(err?.message || err), stack: err?.stack }, null, 2),
    );
    budget.clear();
    cleanup();
    process.exit(1);
  }
}

main();
