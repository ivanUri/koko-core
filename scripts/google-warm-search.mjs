#!/usr/bin/env node
/**
 * Product path: warm google.com → capture cookies → /search.
 * Uses isolated jar via captureRun --cookie-jar lifecycle inside one Velora process.
 *
 *   node scripts/google-warm-search.mjs --q "velora browser"
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = join(REPO, "zig-out/bin/velora");
const OUT = join(REPO, "code-check/tmp/google-warm-search");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

const EXTRACT = `(() => {
  const text = (document.body && document.body.innerText) || '';
  const html = document.documentElement ? document.documentElement.outerHTML : '';
  const href = location.href;
  const lower = (text + ' ' + href + ' ' + html.slice(0, 50000)).toLowerCase();
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const results = qa('#search a h3, #rso h3, div.g h3').slice(0, 8).map((h) => {
    const a = h.closest('a') || h.parentElement?.closest?.('a');
    return { title: (h.textContent || '').trim().slice(0, 100), href: a?.href || null };
  });
  return {
    href, title: document.title || '', htmlLen: html.length, bodyLen: text.length,
    signals: {
      knitsail: html.includes('knitsail') || html.includes('KGX'),
      rso: !!(q('#rso') || q('#search') || q('#result-stats') || q('div.tF2Cxc')),
      sorry: href.includes('/sorry') || lower.includes('unusual traffic'),
    },
    results,
  };
})()`;

function verdictOf(s) {
  if (!s) return "error";
  if (s.signals?.sorry) return "blocked";
  if (s.signals?.knitsail && !s.signals?.rso) return "knitsail_bootstrap";
  if (s.signals?.rso || (s.results?.length ?? 0) > 0) return "serp_ok";
  return "other";
}

const q = process.argv.includes("--q")
  ? process.argv[process.argv.indexOf("--q") + 1]
  : "velora browser";
const profile = "chrome-local-huys-macbook-pro";
mkdirSync(OUT, { recursive: true });

// Empty jar so warm starts cold
const jar = join(OUT, "Cookies.json");
writeFileSync(jar, "[]\n");

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
    "--cookie-jar",
    jar,
    "--log-level",
    "warn",
  ],
  { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
);

for (let i = 0; i < 50; i++) {
  try {
    if ((await fetch(`${endpoint}/json/version`)).ok) break;
  } catch {}
  await delay(100);
}
const ver = await (await fetch(`${endpoint}/json/version`)).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.once("open", r);
  ws.once("error", j);
});
const cdp = new Cdp(ws);
const report = { q, hops: [] };
try {
  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);

  // hop0 warm
  await cdp.send("Page.navigate", { url: "https://www.google.com/" }, sessionId);
  await delay(4000);
  let r = await cdp.send(
    "Runtime.evaluate",
    { expression: EXTRACT, returnByValue: true },
    sessionId,
  );
  const hop0 = r.result?.value;
  report.hops.push({ hop: 0, url: "https://www.google.com/", page: hop0, verdict: verdictOf(hop0) });

  // hop1 search
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en`;
  await cdp.send("Page.navigate", { url: searchUrl }, sessionId);
  await delay(5000);
  r = await cdp.send(
    "Runtime.evaluate",
    { expression: EXTRACT, returnByValue: true },
    sessionId,
    15000,
  );
  const hop1 = r.result?.value;
  report.hops.push({ hop: 1, url: searchUrl, page: hop1, verdict: verdictOf(hop1) });
  report.finalVerdict = verdictOf(hop1);
  report.jarAfter = existsSync(jar) ? JSON.parse(readFileSync(jar, "utf8")).length : 0;
} catch (e) {
  report.error = String(e.message || e);
} finally {
  cdp.close();
  // Graceful exit so profile_session.persistCookies can flush --cookie-jar.
  try {
    proc.kill("SIGTERM");
  } catch {}
  await delay(800);
  try {
    proc.kill("SIGKILL");
  } catch {}
}
writeFileSync(join(OUT, "REPORT.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(report.finalVerdict === "serp_ok" ? 0 : 2);
