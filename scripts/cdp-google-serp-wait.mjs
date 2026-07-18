#!/usr/bin/env node
/**
 * CDP: Google Search — wait for SERP, /sorry, or enablejs shell timeout.
 *
 * Default budget 45s (Google knitsail often needs >20s). Override with --max-sec.
 * On hard limit → SIGKILL, exit 3 (shared probe budget).
 *
 *   node scripts/cdp-google-serp-wait.mjs --q velora
 *   node scripts/cdp-google-serp-wait.mjs --q velora --max-sec 60 --profile chrome-local-huys-macbook-pro
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

/** Same snapshot logic as velora-run/google-serp-wait.mjs */
const SNAPSHOT_EXPR = `(() => {
  const text = (document.body && document.body.innerText) || "";
  const html = document.documentElement ? document.documentElement.outerHTML : "";
  const lower = text.toLowerCase();
  const href = location.href;
  const title = document.title || "";
  const has = (s) => lower.includes(s) || href.toLowerCase().includes(s);
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const results = qa("#search a h3, #rso h3, div.g h3, a h3").slice(0, 12).map((h) => {
    const a = h.closest("a") || h.parentElement?.closest?.("a");
    return { title: (h.textContent || "").trim().slice(0, 140), href: a?.href || null };
  }).filter((r) => r.title);
  const enablejs =
    href.includes("/httpservice/retry/enablejs") ||
    href.includes("enablejs") ||
    !!q('meta[http-equiv="refresh"][content*="enablejs"]') ||
    (has("nếu bạn không được chuyển") && results.length === 0);
  const sorry =
    href.includes("/sorry") ||
    has("unusual traffic") ||
    has("our systems have detected") ||
    has("detected unusual traffic");
  const recaptcha = !!(q('iframe[src*="recaptcha"]') || q("#recaptcha") || q(".g-recaptcha"));
  const consent = !!(q('form[action*="consent"]') || q("#L2AGLb") || has("before you continue") || has("trước khi tiếp tục"));
  const serp = !!q("#rso") || !!q("#search") || !!q("#result-stats") || results.length > 0;
  const knitsail = html.includes("knitsail") || html.includes("KGX") || (html.includes("closureDynamicButton") && !serp);
  let verdict = "pending";
  if (sorry || (recaptcha && !serp)) verdict = "sorry";
  else if (consent && !serp) verdict = "consent";
  else if (serp) verdict = "serp";
  else if (enablejs || knitsail) verdict = "enablejs_shell";
  else if (text.length > 200) verdict = "loaded_unknown";
  else verdict = "empty";
  return {
    href, title, readyState: document.readyState,
    bodyLen: text.length, htmlLen: html.length, verdict,
    signals: {
      sorry, recaptcha, consent, serp, enablejs, knitsail,
      rso: !!q("#rso"), searchRoot: !!q("#search"),
      resultStats: !!q("#result-stats"),
      searchBox: !!(q('textarea[name="q"]') || q('input[name="q"]')),
    },
    resultStats: (q("#result-stats")?.textContent || "").trim().slice(0, 200),
    results,
    bodyHead: text.replace(/\\s+/g, " ").trim().slice(0, 400),
  };
})()`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  // Google wait needs more than generic 20s probes; default 45.
  const out = {
    profile: "chrome-local-huys-macbook-pro",
    maxSec: parseMaxSecArg(argv, 45),
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
    this.navCount = 0;
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.method === "Page.frameNavigated") this.navCount += 1;
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
      // Soft timeout per CDP call so knitsail cannot freeze the poll loop forever.
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 8_000);
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

function isTerminal(v) {
  return v === "serp" || v === "sorry" || v === "consent";
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
  let lastSnapshot = null;
  const cleanup = () => {
    try {
      if (lastSnapshot) {
        writeFileSync(
          resolve(OUT_DIR, "google-serp-wait-partial.json"),
          JSON.stringify(lastSnapshot, null, 2),
        );
      }
    } catch {}
    killProcess(proc);
  };
  const budget = createProbeBudget(args.maxSec, cleanup);
  const started = Date.now();

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

    await client.send("Page.navigate", { url: args.url }, sessionId);

    let polls = 0;
    let last = null;
    while (remainingMs(budget.deadline) > 700) {
      polls += 1;
      await delay(450);
      try {
        last = await evaluate(client, sessionId, SNAPSHOT_EXPR);
        last.poll = polls;
        last.elapsedMs = Date.now() - started;
        last.frameNavEvents = client.navCount;
        lastSnapshot = last;
      } catch (e) {
        last = {
          verdict: "evaluate_error",
          error: String(e.message || e),
          poll: polls,
          elapsedMs: Date.now() - started,
        };
        lastSnapshot = last;
        console.log(`[poll ${polls}] evaluate error: ${last.error}`);
        continue;
      }

      console.log(
        `[poll ${polls}] t=${Math.round((Date.now() - started) / 1000)}s verdict=${last.verdict} href=${(last.href || "").slice(0, 100)}`,
      );
      if (isTerminal(last.verdict)) break;
    }

    let html = "";
    try {
      html = (await evaluate(
        client,
        sessionId,
        "document.documentElement ? document.documentElement.outerHTML : ''",
      )) || "";
    } catch {}

    const report = {
      ok: last?.verdict === "serp",
      urlRequested: args.url,
      maxSec: args.maxSec,
      elapsedMs: Date.now() - started,
      polls,
      final: last,
    };
    const outJson = resolve(OUT_DIR, "google-serp-wait.json");
    const outHtml = resolve(OUT_DIR, "google-serp-wait.html");
    writeFileSync(outJson, JSON.stringify(report, null, 2));
    if (html) writeFileSync(outHtml, html);

    console.log("\n=== Final ===");
    console.log(JSON.stringify(last, null, 2));
    console.log(`\n[saved] ${outJson}`);
    if (html) console.log(`[saved] ${outHtml} (${html.length} bytes)`);

    const v = last?.verdict || "unknown";
    console.log(`\n=== Verdict: ${v} ===`);

    client.close();
    budget.clear();
    cleanup();
    if (v === "serp") process.exit(0);
    if (v === "sorry") process.exit(2);
    if (v === "consent") process.exit(3);
    if (v === "enablejs_shell") process.exit(4);
    process.exit(1);
  } catch (err) {
    console.error("[ERROR]", err);
    budget.clear();
    cleanup();
    process.exit(1);
  }
}

main();
