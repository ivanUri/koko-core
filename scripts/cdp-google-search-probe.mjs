#!/usr/bin/env node
/**
 * Navigate Google Search via CDP and report SERP / antibot surface.
 * Budget: --max-sec (default 20). Hang → SIGKILL exit 3.
 *
 *   node scripts/cdp-google-search-probe.mjs
 *   node scripts/cdp-google-search-probe.mjs --q velora --profile chrome-local-huys-macbook-pro
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  createProbeBudget,
  killProcess,
  parseMaxSecArg,
  waitCdp,
  remainingMs,
} from "./lib/cdp-probe-budget.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const OUT_DIR = resolve(REPO, "code-check/tmp");

const EXTRACT = `(() => {
  const text = (document.body && document.body.innerText) || '';
  const html = document.documentElement ? document.documentElement.outerHTML : '';
  const lower = text.toLowerCase();
  const href = location.href;
  const title = document.title || '';
  const has = (s) => lower.includes(s) || href.toLowerCase().includes(s);
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const results = qa('#search a h3, #rso h3, div.g h3, a h3').slice(0, 8).map((h) => {
    const a = h.closest('a') || h.parentElement?.closest?.('a');
    return { title: (h.textContent || '').trim().slice(0, 120), href: a?.href || null };
  });
  return {
    href,
    title,
    readyState: document.readyState,
    bodyLen: text.length,
    htmlLen: html.length,
    signals: {
      sorry: has('/sorry') || has('unusual traffic') || has('captcha'),
      consent: !!(q('form[action*="consent"]') || q('#L2AGLb') || has('before you continue')),
      recaptcha: !!(q('iframe[src*="recaptcha"]') || q('#recaptcha') || has('recaptcha')),
      knitsail: html.includes('knitsail') || html.includes('KGX'),
      searchBox: !!(q('textarea[name="q"]') || q('input[name="q"]')),
      resultStats: !!(q('#result-stats') || q('#appbar')),
      rso: !!q('#rso') || !!q('#search'),
    },
    resultStats: (q('#result-stats')?.textContent || '').trim().slice(0, 160),
    results,
    bodyHead: text.replace(/\\s+/g, ' ').trim().slice(0, 500),
  };
})()`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {
    profile: "chrome-local-huys-macbook-pro",
    maxSec: parseMaxSecArg(argv, 20),
    q: "velora",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--q") out.q = argv[++i];
  }
  out.url = `https://www.google.com/search?q=${encodeURIComponent(out.q)}`;
  return out;
}

async function getFreePort() {
  return new Promise((res, rej) => {
    const s = createNetServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

class CdpClient {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId = null) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
  close() {
    this.ws.close();
  }
}

async function evaluate(client, sessionId, expression) {
  const result = await client.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: false },
    sessionId,
  );
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "evaluate failed");
  }
  return result.result?.value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(VELORA_BIN)) {
    console.error("missing binary:", VELORA_BIN);
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const port = await getFreePort();
  const endpoint = `http://127.0.0.1:${port}`;
  let proc = null;
  const cleanup = () => killProcess(proc);
  const budget = createProbeBudget(args.maxSec, cleanup);

  console.log(`[probe] ${args.url}`);
  console.log(`[probe] profile=${args.profile} maxSec=${args.maxSec}`);

  proc = spawn(
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
    { cwd: REPO, stdio: "ignore" },
  );

  let client = null;
  try {
    await waitCdp(endpoint, budget.deadline);
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.once("open", res);
      ws.once("error", rej);
    });
    client = new CdpClient(ws);
    await client.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);
    await client.send("Network.enable", {}, sessionId).catch(() => {});

    const nav = await client.send("Page.navigate", { url: args.url }, sessionId);
    console.log("[probe] navigate frameId=", nav.frameId || "?", "loaderId=", nav.loaderId || "?");

    // Poll until we have substantial body or antibot, within budget.
    let last = null;
    while (remainingMs(budget.deadline) > 600) {
      await delay(400);
      try {
        last = await evaluate(client, sessionId, EXTRACT);
      } catch (e) {
        last = { error: String(e.message || e) };
        continue;
      }
      if (!last || last.error) continue;
      const okSerp =
        last.signals?.rso ||
        last.signals?.resultStats ||
        (last.results && last.results.length > 0);
      const blocked = last.signals?.sorry || last.signals?.recaptcha;
      if ((okSerp || blocked) && last.bodyLen > 200) break;
      if (last.readyState === "complete" && last.bodyLen > 2000) break;
    }

    // Snapshot HTML for forensics
    let html = "";
    try {
      html =
        (await evaluate(
          client,
          sessionId,
          "document.documentElement ? document.documentElement.outerHTML : ''",
        )) || "";
    } catch {}
    const outHtml = resolve(OUT_DIR, "google-search-velora.html");
    const outJson = resolve(OUT_DIR, "google-search-velora.json");
    if (html) writeFileSync(outHtml, html);
    writeFileSync(outJson, JSON.stringify(last, null, 2));

    console.log("\n=== Google Search probe ===\n");
    console.log(JSON.stringify(last, null, 2));
    console.log(`\n[saved] ${outJson}`);
    if (html) console.log(`[saved] ${outHtml} (${html.length} bytes)`);

    const s = last?.signals || {};
    let verdict = "unknown";
    if (s.sorry || s.recaptcha) verdict = "BLOCKED (sorry/captcha)";
    else if (s.consent && !s.rso) verdict = "CONSENT interstitial";
    else if (s.rso || (last?.results?.length ?? 0) > 0) verdict = "SERP OK";
    else if ((last?.bodyLen ?? 0) > 500) verdict = "LOADED (no classic SERP markers)";
    else verdict = "EMPTY / incomplete";

    console.log(`\n=== Verdict: ${verdict} ===`);
    client.close();
    budget.clear();
    cleanup();
    process.exit(s.sorry || s.recaptcha ? 1 : 0);
  } catch (err) {
    console.error("[ERROR]", err);
    budget.clear();
    cleanup();
    process.exit(1);
  }
}

main();
