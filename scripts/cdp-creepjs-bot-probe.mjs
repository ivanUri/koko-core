#!/usr/bin/env node
/**
 * Load CreepJS and extract headless / stealth / lie signals (bot-like).
 * Budget: --max-sec (default 20). Hang → SIGKILL, exit 3.
 *
 *   node scripts/cdp-creepjs-bot-probe.mjs
 *   node scripts/cdp-creepjs-bot-probe.mjs --url https://abrahamjuliot.github.io/creepjs/
 *   node scripts/cdp-creepjs-bot-probe.mjs --url file:///.../code-check/sites/creep/index.html
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync } from "node:fs";
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
const DEFAULT_URL = "https://abrahamjuliot.github.io/creepjs/";
const LOCAL_URL = `file://${resolve(REPO, "code-check/sites/creep/index.html")}`;

const EXTRACT = `(() => {
  const fp = window.Fingerprint;
  if (!fp) {
    return {
      ready: false,
      hasFp: false,
      bodyText: (document.body && document.body.innerText || '').slice(0, 400),
      title: document.title || '',
    };
  }
  const h = fp.headless || {};
  const like = h.likeHeadless || {};
  const head = h.headless || {};
  const stealth = h.stealth || {};
  const trueKeys = (obj) => Object.entries(obj || {}).filter(([, v]) => !!v).map(([k]) => k);
  return {
    ready: true,
    hasFp: true,
    workerScope: !!fp.workerScope,
    lies: fp.lies || null,
    lieTotal: fp.lies?.totalLies ?? fp.lies?.data?.length ?? null,
    headlessRating: h.headlessRating ?? null,
    likeHeadlessRating: h.likeHeadlessRating ?? null,
    stealthRating: h.stealthRating ?? null,
    likeHeadlessTrue: trueKeys(like),
    headlessTrue: trueKeys(head),
    stealthTrue: trueKeys(stealth),
    likeHeadless: like,
    headless: head,
    stealth: stealth,
    systemFonts: h.systemFonts ?? null,
    platformEstimate: h.platformEstimate ?? null,
    resistance: fp.resistance ? {
      privacy: fp.resistance.privacy,
      security: fp.resistance.security,
      mode: fp.resistance.mode,
    } : null,
    navigatorWebdriver: navigator.webdriver,
    windowHasWebdriver: 'webdriver' in window,
    ontouchstart: 'ontouchstart' in window,
    maxTouchPoints: navigator.maxTouchPoints,
    chromeKeys: window.chrome ? Object.keys(window.chrome) : null,
    pluginsLen: navigator.plugins?.length ?? null,
  };
})()`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {
    profile: "chrome-local-huys-macbook-pro",
    maxSec: parseMaxSecArg(argv, 20),
    url: DEFAULT_URL,
    local: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--local") {
      out.local = true;
      out.url = LOCAL_URL;
    }
  }
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

  const port = await getFreePort();
  const endpoint = `http://127.0.0.1:${port}`;
  let proc = null;
  const cleanup = () => killProcess(proc);
  const budget = createProbeBudget(args.maxSec, cleanup);

  console.log(`[probe] url=${args.url} profile=${args.profile} maxSec=${args.maxSec}`);

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

    console.log("[probe] navigate…");
    await client.send("Page.navigate", { url: args.url }, sessionId);

    let last = null;
    let attempts = 0;
    while (remainingMs(budget.deadline) > 800) {
      attempts += 1;
      await delay(500);
      try {
        last = await evaluate(client, sessionId, EXTRACT);
      } catch (e) {
        last = { ready: false, error: String(e.message || e) };
      }
      if (last?.ready) break;
      if (attempts % 4 === 0) {
        console.log(
          `[probe] waiting Fingerprint… t=${Math.round(remainingMs(budget.deadline) / 1000)}s left`,
          last?.title || last?.error || "",
        );
      }
    }

    if (!last?.ready) {
      console.error("[INCOMPLETE] window.Fingerprint not ready within budget");
      console.log(JSON.stringify(last, null, 2));
      budget.clear();
      cleanup();
      process.exit(1);
    }

    console.log("\n=== CreepJS bot/headless surface ===\n");
    console.log(JSON.stringify(last, null, 2));

    const flags = [
      ...(last.likeHeadlessTrue || []).map((k) => `likeHeadless.${k}`),
      ...(last.headlessTrue || []).map((k) => `headless.${k}`),
      ...(last.stealthTrue || []).map((k) => `stealth.${k}`),
    ];

    console.log("\n=== Summary ===");
    console.log(`likeHeadlessRating: ${last.likeHeadlessRating}%`);
    console.log(`headlessRating:     ${last.headlessRating}%`);
    console.log(`stealthRating:      ${last.stealthRating}%`);
    console.log(`lieTotal:           ${last.lieTotal}`);
    console.log(`true bot-like keys: ${flags.length ? flags.join(", ") : "(none)"}`);

    client.close();
    budget.clear();
    cleanup();
    process.exit(0);
  } catch (err) {
    console.error("[ERROR]", err);
    budget.clear();
    cleanup();
    process.exit(1);
  }
}

main();
