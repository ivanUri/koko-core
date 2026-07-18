#!/usr/bin/env node
/**
 * Layer-0 Google Search path (practical):
 *   1) Export live cookies from a Chrome profile (Keychain decrypt via browser_cookie3)
 *   2) Write Velora Cookies.json for the target profile
 *   3) Fresh Velora session → Google Search → report tier
 *
 * No Chrome import into Velora process — only cookie jar injection.
 *
 *   node scripts/chrome-profile-cookie-search.mjs --chrome-profile 57 --q velora
 *   node scripts/chrome-profile-cookie-search.mjs --chrome-profile 45 --q velora
 *   node scripts/chrome-profile-cookie-search.mjs --skip-export   # use jar already on disk
 *
 * Env:
 *   VELORA_COOKIE_PYTHON  python with browser_cookie3 (default: ../velora-run/.venv-cookies)
 *   VELORA_BIN            path to zig-out/bin/velora
 *   VELORA_PROFILE        velora browser profile id (default chrome-local-huys-macbook-pro)
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = process.env.VELORA_BIN ?? join(REPO, "zig-out/bin/velora");
const EXPORT_PY = join(REPO, "scripts/export-chrome-live-cookies.py");
const PYTHON =
  process.env.VELORA_COOKIE_PYTHON ??
  join(REPO, "../velora-run/.venv-cookies/bin/python");
const OUT_DIR = join(REPO, "code-check/tmp/chrome-cookie-search");

function parseArgs(argv) {
  const out = {
    chromeProfile: process.env.VELORA_CHROME_PROFILE ?? "57",
    profile: process.env.VELORA_PROFILE ?? "chrome-local-huys-macbook-pro",
    q: process.env.VELORA_Q ?? "velora",
    skipExport: false,
    waitMs: Number(process.env.VELORA_WAIT_MS ?? 5000),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--chrome-profile") out.chromeProfile = argv[++i] ?? out.chromeProfile;
    else if (a === "--profile") out.profile = argv[++i] ?? out.profile;
    else if (a === "--q" || a === "--query") out.q = argv[++i] ?? out.q;
    else if (a === "--skip-export") out.skipExport = true;
    else if (a === "--wait-ms") out.waitMs = Number(argv[++i] ?? out.waitMs);
  }
  out.searchUrl = `https://www.google.com/search?q=${encodeURIComponent(out.q)}&hl=en`;
  // Chrome macOS dirs: "Profile 57" or "Default"
  out.chromeCookieDb =
    process.env.VELORA_CHROME_COOKIE_DB ??
    join(
      homedir(),
      "Library/Application Support/Google/Chrome",
      out.chromeProfile === "Default" ? "Default" : `Profile ${out.chromeProfile}`,
      "Cookies",
    );
  out.jar = join(
    homedir(),
    "Library/Application Support/velora",
    out.profile,
    "Cookies.json",
  );
  return out;
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

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

function exportCookies(args) {
  if (!existsSync(PYTHON)) {
    throw new Error(`Missing python with browser_cookie3: ${PYTHON}`);
  }
  if (!existsSync(args.chromeCookieDb)) {
    throw new Error(`Chrome Cookies DB not found: ${args.chromeCookieDb}`);
  }
  console.log(`[export] Chrome Profile ${args.chromeProfile} → ${args.profile}`);
  console.log(`[export] db=${args.chromeCookieDb}`);
  const r = spawnSync(
    PYTHON,
    [EXPORT_PY, "--cookie-file", args.chromeCookieDb, "--profile", args.profile],
    { cwd: REPO, encoding: "utf8" },
  );
  process.stdout.write(r.stdout || "");
  process.stderr.write(r.stderr || "");
  if (r.status !== 0) throw new Error(`export failed status=${r.status}`);
}

function summarizeJar(jarPath) {
  try {
    const cookies = JSON.parse(readFileSync(jarPath, "utf8"));
    const names = [...new Set(cookies.map((c) => c.name))].sort();
    return {
      total: cookies.length,
      names: names.slice(0, 40),
      hasSID: names.some((n) =>
        ["SID", "__Secure-1PSID", "HSID", "APISID"].includes(n),
      ),
      hasNID: names.includes("NID"),
      hasAEC: names.includes("AEC"),
    };
  } catch {
    return { total: 0, names: [], hasSID: false, hasNID: false, hasAEC: false };
  }
}

const EXTRACT = `(() => {
  const text = (document.body && document.body.innerText) || '';
  const html = document.documentElement ? document.documentElement.outerHTML : '';
  const href = location.href;
  const lower = (text + ' ' + href).toLowerCase();
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const results = qa('#search a h3, #rso h3, div.g h3').slice(0, 8).map((h) => {
    const a = h.closest('a') || h.parentElement?.closest?.('a');
    return { title: (h.textContent || '').trim().slice(0, 100), href: a?.href || null };
  });
  let pageT = null;
  try { pageT = chrome.csi().pageT; } catch {}
  return {
    href: href.slice(0, 220),
    title: (document.title || '').slice(0, 120),
    readyState: document.readyState,
    bodyLen: text.length,
    htmlLen: html.length,
    pageT,
    hasTrustedTypes: typeof trustedTypes !== 'undefined',
    signals: {
      sorry: href.includes('/sorry') || lower.includes('unusual traffic'),
      knitsail: html.includes('knitsail') || html.includes('KGX'),
      rso: !!(q('#rso') || q('#search') || q('#result-stats')),
      recaptcha: !!(q('iframe[src*="recaptcha"]') || q('#recaptcha')),
    },
    results,
  };
})()`;

async function waitCdp(endpoint, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${endpoint}/json/version`)).ok) return true;
    } catch {}
    await delay(100);
  }
  return false;
}

async function search(args) {
  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const proc = spawn(
    VELORA_BIN,
    [
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--browser-profile",
      args.profile,
      "--log-level",
      "warn",
    ],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  proc.stderr?.on("data", (d) => {
    stderr += String(d);
  });
  if (!(await waitCdp(endpoint))) {
    proc.kill("SIGKILL");
    throw new Error(`CDP not ready\n${stderr.slice(-800)}`);
  }
  const version = await (await fetch(`${endpoint}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  const client = new Cdp(ws);
  try {
    await client.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);

    console.log(`[search] ${args.searchUrl}`);
    try {
      await client.send("Page.navigate", { url: args.searchUrl }, sessionId, 20000);
    } catch (e) {
      console.log(`[search] navigate: ${e.message}`);
    }
    await delay(args.waitMs);

    let last = null;
    for (let i = 0; i < 12; i++) {
      await delay(500);
      try {
        const r = await client.send(
          "Runtime.evaluate",
          { expression: EXTRACT, returnByValue: true },
          sessionId,
          10000,
        );
        last = r.result?.value;
        if (
          last?.signals?.rso ||
          last?.signals?.sorry ||
          last?.signals?.knitsail ||
          last?.signals?.recaptcha ||
          (last?.htmlLen ?? 0) > 5000
        ) {
          break;
        }
      } catch {}
    }
    return last;
  } finally {
    client.close();
    await delay(300);
    proc.kill("SIGTERM");
    await delay(400);
    try {
      proc.kill("SIGKILL");
    } catch {}
  }
}

function verdictOf(page) {
  const s = page?.signals || {};
  if (s.sorry || s.recaptcha) return "BLOCKED (sorry/captcha)";
  if (s.knitsail && !s.rso) return "knitsail_bootstrap";
  if (s.rso || (page?.results?.length ?? 0) > 0) return "SERP OK";
  if ((page?.htmlLen ?? 0) > 5000) return "LOADED (no SERP markers)";
  return "EMPTY / incomplete";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(dirname(args.jar), { recursive: true });

  console.log("=== Chrome profile cookie → Velora search ===");
  console.log(`chromeProfile=${args.chromeProfile}`);
  console.log(`veloraProfile=${args.profile}`);
  console.log(`jar=${args.jar}`);

  if (!args.skipExport) {
    if (existsSync(args.jar)) {
      copyFileSync(args.jar, `${args.jar}.bak.pre-cookie-search`);
    }
    exportCookies(args);
  } else {
    console.log("[export] skipped — using existing jar");
  }

  const jarSummary = summarizeJar(args.jar);
  console.log("[jar]", JSON.stringify(jarSummary));
  writeFileSync(join(OUT_DIR, "jar-summary.json"), JSON.stringify(jarSummary, null, 2));
  if (existsSync(args.jar)) {
    copyFileSync(args.jar, join(OUT_DIR, "Cookies.json"));
  }

  const page = await search(args);
  const verdict = verdictOf(page);
  const report = {
    chromeProfile: args.chromeProfile,
    chromeCookieDb: args.chromeCookieDb,
    veloraProfile: args.profile,
    jar: args.jar,
    jarSummary,
    searchUrl: args.searchUrl,
    page,
    verdict,
  };
  writeFileSync(join(OUT_DIR, "REPORT.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(OUT_DIR, "search-page.json"), JSON.stringify(page, null, 2));

  console.log("\n=== Search ===");
  console.log(
    JSON.stringify(
      {
        href: page?.href,
        title: page?.title,
        htmlLen: page?.htmlLen,
        signals: page?.signals,
        results: page?.results?.slice(0, 3),
        pageT: page?.pageT,
      },
      null,
      2,
    ),
  );
  console.log(`\n=== Verdict: ${verdict} ===`);
  console.log(`artifacts: ${OUT_DIR}`);
  process.exit(verdict.startsWith("SERP") ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
