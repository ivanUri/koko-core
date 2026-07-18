#!/usr/bin/env node
/**
 * Navigate key browserleaks.com endpoints via Velora CDP and dump structured signals.
 * Budget: --max-sec (default 45 total hard kill).
 *
 *   node scripts/browserleaks-velora-probe.mjs
 *   node scripts/browserleaks-velora-probe.mjs --only tls,quic,ip,js
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  createProbeBudget,
  killProcess,
  parseMaxSecArg,
  waitCdp,
} from "./lib/cdp-probe-budget.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
const OUT_DIR = join(REPO, "code-check/tmp/browserleaks-probe");

const TARGETS = {
  tls: "https://tls.browserleaks.com/json",
  quic: "https://quic.browserleaks.com/json",
  ip: "https://browserleaks.com/ip",
  js: "https://browserleaks.com/javascript",
  canvas: "https://browserleaks.com/canvas",
  webgl: "https://browserleaks.com/webgl",
};

const EXTRACT_JSON = `(() => {
  try {
    const t = (document.body && document.body.innerText) || '';
    const j = JSON.parse(t);
    return { kind: 'json', json: j, href: location.href, htmlLen: document.documentElement.outerHTML.length };
  } catch (e) {
    return { kind: 'html', href: location.href, title: document.title,
      bodyHead: ((document.body && document.body.innerText) || '').replace(/\\s+/g,' ').trim().slice(0, 1200),
      htmlLen: document.documentElement ? document.documentElement.outerHTML.length : 0 };
  }
})()`;

const EXTRACT_JS_PAGE = `(() => {
  const text = (document.body && document.body.innerText) || '';
  const grab = (label) => {
    const re = new RegExp(label + '\\\\s*[:\\\\n]\\\\s*([^\\\\n]+)', 'i');
    const m = text.match(re);
    return m ? m[1].trim().slice(0, 200) : null;
  };
  return {
    kind: 'js_page',
    href: location.href,
    title: document.title,
    webdriver: navigator.webdriver,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    languages: [...navigator.languages],
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
    uaPlatform: navigator.userAgentData ? navigator.userAgentData.platform : null,
    plugins: [...navigator.plugins].map((p) => p.name),
    bodyHead: text.replace(/\\s+/g, ' ').trim().slice(0, 1500),
    fields: {
      userAgent: grab('User Agent') || navigator.userAgent,
      platform: grab('Platform') || navigator.platform,
      webdriver: grab('WebDriver') || String(navigator.webdriver),
    },
  };
})()`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {
    profile: "chrome-local-huys-macbook-pro",
    maxSec: parseMaxSecArg(argv, 45),
    only: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--only")
      out.only = String(argv[++i] || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === "--max-sec") out.maxSec = Number(argv[++i] || 45);
  }
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
  send(method, params = {}, sessionId, timeoutMs = 15000) {
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(VELORA_BIN)) {
    console.error("missing zig-out/bin/velora");
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const names = args.only || ["tls", "quic", "ip", "js"];
  const jobs = names.map((n) => ({ id: n, url: TARGETS[n] })).filter((j) => j.url);

  let proc = null;
  const cleanup = () => killProcess(proc, "SIGKILL");
  const budget = createProbeBudget(args.maxSec, cleanup);

  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
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
    { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await waitCdp(endpoint, budget.deadline);
  } catch (e) {
    budget.failHang("cdp_ready", String(e));
  }

  const version = await (await fetch(`${endpoint}/json/version`)).json();
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  const client = new Cdp(ws);
  const results = {};

  try {
    await client.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    for (const job of jobs) {
      if (budget.remaining() < 3000) break;
      console.log(`[nav] ${job.id} ${job.url}`);
      const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await client.send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      await client.send("Page.enable", {}, sessionId);
      await client.send("Runtime.enable", {}, sessionId);
      try {
        await client.send("Page.navigate", { url: job.url }, sessionId, Math.min(20000, budget.remaining()));
      } catch (e) {
        console.log(`[nav] ${job.id} navigate: ${e.message}`);
      }
      await delay(Math.min(3500, budget.remaining()));
      const expr = job.id === "js" || job.id === "canvas" || job.id === "webgl" ? EXTRACT_JS_PAGE : EXTRACT_JSON;
      let last = null;
      for (let i = 0; i < 8; i++) {
        if (budget.remaining() < 1500) break;
        try {
          const r = await client.send(
            "Runtime.evaluate",
            { expression: expr, returnByValue: true },
            sessionId,
            Math.min(10000, budget.remaining()),
          );
          last = r.result?.value;
          if (last?.kind === "json" || (last?.htmlLen ?? 0) > 2000 || last?.userAgent) break;
        } catch {}
        await delay(500);
      }
      results[job.id] = last;
      writeFileSync(join(OUT_DIR, `${job.id}.json`), JSON.stringify(last, null, 2));
      await client.send("Target.closeTarget", { targetId }).catch(() => {});
      console.log(
        `[ok] ${job.id}`,
        last?.kind,
        last?.json?.ja4 || last?.json?.ja3_hash || last?.webdriver || last?.title || "",
      );
    }
  } finally {
    client.close();
    budget.clear();
    cleanup();
  }

  const summary = {
    profile: args.profile,
    stamp: new Date().toISOString(),
    results: Object.fromEntries(
      Object.entries(results).map(([k, v]) => {
        if (!v) return [k, null];
        if (v.kind === "json" && v.json) {
          const j = v.json;
          return [
            k,
            {
              ja4: j.ja4,
              ja4_r: j.ja4_r,
              ja3n_hash: j.ja3n_hash,
              akamai_hash: j.akamai_hash,
              akamai_text: j.akamai_text,
              h3_text: j.h3_text,
              h3_hash: j.h3_hash,
              ech_success: j.ech_success,
              user_agent: j.user_agent,
              keys: Object.keys(j).slice(0, 25),
            },
          ];
        }
        return [
          k,
          {
            kind: v.kind,
            webdriver: v.webdriver,
            userAgent: v.userAgent,
            platform: v.platform,
            brands: v.brands,
            bodyHead: (v.bodyHead || "").slice(0, 400),
          },
        ];
      }),
    ),
  };
  writeFileSync(join(OUT_DIR, "SUMMARY.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`artifacts: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
