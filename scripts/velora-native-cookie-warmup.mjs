#!/usr/bin/env node
/**
 * Pure-Velora cookie warmup (no Chrome import):
 *   1) empty jar
 *   2) browse google + a few sites (like a normal user)
 *   3) save Cookies.json that Velora set via Set-Cookie
 *   4) new session → Google Search and report tier
 *
 *   node scripts/velora-native-cookie-warmup.mjs
 *   node scripts/velora-native-cookie-warmup.mjs --profile chrome-local-huys-macbook-pro --q velora
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = process.env.VELORA_BIN ?? join(REPO, "zig-out/bin/velora");
const OUT_DIR = join(REPO, "code-check/tmp/native-warmup");

// Light pages only — heavy sites (YouTube) can stall CDP and lose cookie export.
const WARMUP_URLS = [
  "https://www.google.com/",
  "https://www.google.com/?hl=en",
  "https://www.google.com/ncr",
  "https://en.wikipedia.org/wiki/Main_Page",
  "https://news.ycombinator.com/",
  "https://www.google.com/",
];

function parseArgs(argv) {
  const out = {
    profile: process.env.VELORA_PROFILE ?? "chrome-local-huys-macbook-pro",
    q: process.env.VELORA_Q ?? "velora",
    waitMs: Number(process.env.VELORA_WARMUP_WAIT_MS ?? 3500),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i] ?? out.profile;
    else if (a === "--q" || a === "--query") out.q = argv[++i] ?? out.q;
    else if (a === "--wait-ms") out.waitMs = Number(argv[++i] ?? out.waitMs);
  }
  out.searchUrl = `https://www.google.com/search?q=${encodeURIComponent(out.q)}&hl=en`;
  return out;
}

function jarPath(profile) {
  return join(homedir(), "Library/Application Support/velora", profile, "Cookies.json");
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

async function waitCdp(endpoint, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${endpoint}/json/version`)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
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
  send(method, params = {}, sessionId, timeoutMs = 12000) {
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

async function openSession(profile) {
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
      profile,
      "--log-level",
      "warn",
    ],
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  proc.stderr?.on("data", (d) => {
    stderr += String(d);
  });
  if (!(await waitCdp(endpoint, 20000))) {
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
  await client.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  await client.send("Network.enable", {}, sessionId).catch(() => {});
  return { proc, client, sessionId, endpoint, stderr: () => stderr };
}

async function closeSession({ proc, client }) {
  try {
    // Close target so CDP deinit persists cookies
    client.close();
  } catch {}
  await delay(400);
  if (proc && !proc.killed) {
    proc.kill("SIGTERM");
    await delay(500);
    try {
      proc.kill("SIGKILL");
    } catch {}
  }
  await delay(300);
}

async function navigate(client, sessionId, url, waitMs) {
  console.log(`  → ${url}`);
  try {
    await client.send("Page.navigate", { url }, sessionId, 15000);
  } catch (e) {
    console.log(`    navigate error: ${e.message || e}`);
  }
  await delay(waitMs);
  try {
    const r = await client.send(
      "Runtime.evaluate",
      {
        expression: `({href: location.href, title: document.title, ready: document.readyState, cookieLen: (document.cookie||'').length})`,
        returnByValue: true,
      },
      sessionId,
      8000,
    );
    const v = r.result?.value;
    if (v) console.log(`    title=${(v.title || "").slice(0, 50)} cookieDoc=${v.cookieLen} ready=${v.ready}`);
    return v;
  } catch (e) {
    console.log(`    evaluate error: ${e.message || e}`);
    return null;
  }
}

function saveJar(jar, cookies, outDir, tag) {
  const jarCookies = toJarFormat(cookies);
  writeFileSync(jar, JSON.stringify(jarCookies, null, 2) + "\n");
  if (outDir && tag) {
    writeFileSync(join(outDir, `cookies-${tag}.json`), JSON.stringify(jarCookies, null, 2));
  }
  return jarCookies;
}

async function getAllCookies(client, sessionId) {
  // Prefer Network.getAllCookies; fall back to empty
  try {
    const r = await client.send("Network.getAllCookies", {}, sessionId);
    return r.cookies || [];
  } catch {
    try {
      const r = await client.send("Network.getAllCookies", {});
      return r.cookies || [];
    } catch (e) {
      console.log(`  getAllCookies failed: ${e.message || e}`);
      return [];
    }
  }
}

function toJarFormat(cdpCookies) {
  return cdpCookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    expires: c.expires && c.expires > 0 ? c.expires : undefined,
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite || "None",
  }));
}

function summarizeCookies(cookies) {
  const google = cookies.filter(
    (c) => (c.domain || "").includes("google") || (c.domain || "").includes("youtube"),
  );
  const names = [...new Set(google.map((c) => c.name))].sort();
  return {
    total: cookies.length,
    googleRelated: google.length,
    names: names.slice(0, 40),
    hasNID: names.includes("NID"),
    hasAEC: names.includes("AEC"),
    hasSID: names.includes("SID") || names.includes("__Secure-1PSID"),
  };
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
  return {
    href,
    title: document.title || '',
    bodyLen: text.length,
    htmlLen: html.length,
    signals: {
      sorry: href.includes('/sorry') || lower.includes('unusual traffic'),
      knitsail: html.includes('knitsail') || html.includes('KGX'),
      rso: !!(q('#rso') || q('#search') || q('#result-stats')),
      recaptcha: !!(q('iframe[src*="recaptcha"]') || q('#recaptcha')),
    },
    results,
  };
})()`;

async function searchProbe(profile, searchUrl, waitMs) {
  const session = await openSession(profile);
  try {
    await navigate(session.client, session.sessionId, searchUrl, waitMs + 1500);
    let last = null;
    for (let i = 0; i < 8; i++) {
      await delay(500);
      try {
        const r = await session.client.send(
          "Runtime.evaluate",
          { expression: EXTRACT, returnByValue: true },
          session.sessionId,
        );
        last = r.result?.value;
        if (!last) continue;
        if (last.signals?.rso || last.signals?.sorry || last.signals?.recaptcha) break;
        if (last.htmlLen > 5000) break;
      } catch {}
    }
    const cookies = await getAllCookies(session.client, session.sessionId);
    return { page: last, cookies };
  } finally {
    await closeSession(session);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(OUT_DIR, { recursive: true });
  const jar = jarPath(args.profile);
  mkdirSync(dirname(jar), { recursive: true });

  console.log("=== Velora native cookie warmup (no Chrome import) ===");
  console.log(`profile=${args.profile}`);
  console.log(`jar=${jar}`);
  console.log(`search=${args.searchUrl}`);

  // Backup existing jar (may be Chrome import)
  if (existsSync(jar)) {
    const bak = `${jar}.bak.pre-native-warmup`;
    copyFileSync(jar, bak);
    console.log(`[backup] ${bak}`);
  }

  // 1) Empty jar so bootstrap loads nothing
  writeFileSync(jar, "[]\n");
  console.log("[1] emptied Cookies.json");

  // 2) Warmup browse — snapshot cookies after every successful page
  console.log("[2] warmup browse…");
  let bestCookies = [];
  const warm = await openSession(args.profile);
  try {
    await warm.client.send("Network.clearBrowserCookies", {}, warm.sessionId).catch(() => {});
    let i = 0;
    for (const url of WARMUP_URLS) {
      i += 1;
      await navigate(warm.client, warm.sessionId, url, args.waitMs);
      const snap = await getAllCookies(warm.client, warm.sessionId);
      if (snap.length > bestCookies.length) {
        bestCookies = snap;
        saveJar(jar, bestCookies, OUT_DIR, `after-${i}`);
        console.log(`    jar snapshot: ${bestCookies.length} cookies`);
      } else if (snap.length > 0) {
        console.log(`    jar snapshot: ${snap.length} cookies (kept best ${bestCookies.length})`);
      } else {
        console.log(`    jar snapshot: 0 (CDP empty / timeout)`);
      }
    }
    // final dump attempt
    const cookies = await getAllCookies(warm.client, warm.sessionId);
    if (cookies.length >= bestCookies.length) bestCookies = cookies;
    const jarCookies = saveJar(jar, bestCookies, OUT_DIR, "warmup-final");
    writeFileSync(join(OUT_DIR, "warmup-cookies.json"), JSON.stringify(jarCookies, null, 2));
    const sum = summarizeCookies(jarCookies);
    console.log("[2] cookies after warmup:", JSON.stringify(sum, null, 2));
    writeFileSync(join(OUT_DIR, "warmup-summary.json"), JSON.stringify(sum, null, 2));
  } finally {
    await closeSession(warm);
  }

  // Re-read jar after persist (session deinit may rewrite)
  await delay(600);
  let jarAfter = [];
  try {
    jarAfter = JSON.parse(readFileSync(jar, "utf8"));
  } catch {
    jarAfter = [];
  }
  console.log(`[3] jar on disk after session end: ${Array.isArray(jarAfter) ? jarAfter.length : "?"} cookies`);
  // Prefer the larger of CDP dump vs disk (persist may have rewritten)
  let cdpDump = bestCookies.length ? toJarFormat(bestCookies) : [];
  try {
    const fromFile = JSON.parse(readFileSync(join(OUT_DIR, "warmup-cookies.json"), "utf8"));
    if (Array.isArray(fromFile) && fromFile.length > cdpDump.length) cdpDump = fromFile;
  } catch {}
  if (Array.isArray(cdpDump) && cdpDump.length > (jarAfter?.length || 0)) {
    writeFileSync(jar, JSON.stringify(cdpDump, null, 2) + "\n");
    console.log(`[3] restored CDP dump to jar (${cdpDump.length} cookies)`);
  }
  if ((jarAfter?.length || 0) === 0 && cdpDump.length === 0) {
    console.error("[3] FAIL: native warmup produced empty jar — abort search");
    writeFileSync(
      join(OUT_DIR, "REPORT.json"),
      JSON.stringify({ profile: args.profile, jar, verdict: "EMPTY_JAR", warmupUrls: WARMUP_URLS }, null, 2),
    );
    process.exit(3);
  }

  // 4) New session → search with native jar only
  console.log("[4] fresh session + Google Search…");
  const result = await searchProbe(args.profile, args.searchUrl, args.waitMs);
  writeFileSync(join(OUT_DIR, "search-result.json"), JSON.stringify(result.page, null, 2));
  writeFileSync(
    join(OUT_DIR, "search-cookies.json"),
    JSON.stringify(toJarFormat(result.cookies || []), null, 2),
  );

  const s = result.page?.signals || {};
  let verdict = "unknown";
  if (s.sorry || s.recaptcha) verdict = "BLOCKED (sorry/captcha)";
  else if (s.knitsail && !s.rso) verdict = "knitsail_bootstrap";
  else if (s.rso || (result.page?.results?.length ?? 0) > 0) verdict = "SERP OK";
  else if ((result.page?.htmlLen ?? 0) > 5000) verdict = "LOADED (no SERP markers)";
  else verdict = "EMPTY / incomplete";

  console.log("\n=== Search result ===");
  console.log(JSON.stringify(result.page, null, 2));
  console.log(`\n=== Verdict: ${verdict} ===`);
  console.log(`artifacts: ${OUT_DIR}`);

  const report = {
    profile: args.profile,
    jar,
    warmupUrls: WARMUP_URLS,
    cookieSummary: summarizeCookies(
      existsSync(jar) ? JSON.parse(readFileSync(jar, "utf8")) : [],
    ),
    search: result.page,
    verdict,
  };
  writeFileSync(join(OUT_DIR, "REPORT.json"), JSON.stringify(report, null, 2));
  process.exit(verdict.startsWith("SERP") ? 0 : 2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
