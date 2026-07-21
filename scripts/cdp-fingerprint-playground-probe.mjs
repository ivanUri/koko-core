#!/usr/bin/env node
/**
 * Probe https://demo.fingerprint.com/playground hydration under Velora CDP.
 *
 *   node scripts/cdp-fingerprint-playground-probe.mjs
 *   node scripts/cdp-fingerprint-playground-probe.mjs --max-sec 45
 *
 * Hang → SIGKILL, exit 3. Do not blind-retry.
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
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
const OUT_DIR = join(REPO, "code-check/tmp/fingerprint-playground");
const URL = "https://demo.fingerprint.com/playground";

const SNAP = `(() => {
  const body = (document.body && document.body.innerText) || '';
  const keys = Object.keys(window).filter((k) =>
    /next|webpack|fp|fingerprint|__next|TURBO|React/i.test(k)
  );
  const chunk = window.webpackChunk_N_E;
  let chunkLen = null;
  let chunkTypes = null;
  try {
    if (Array.isArray(chunk)) {
      chunkLen = chunk.length;
      chunkTypes = chunk.slice(0, 5).map((e) =>
        Array.isArray(e) ? e.map((x) => typeof x).join(',') : typeof e
      );
    }
  } catch {}
  const scripts = [...document.scripts].map((s) => ({
    src: (s.src || '').slice(-80),
    async: !!s.async,
    defer: !!s.defer,
    type: s.type || '',
    hasSrc: !!s.src,
    len: (s.textContent || '').length,
  }));
  const hasVisitor =
    /visitor\\s*id|Visitor ID|your visitor/i.test(body) ||
    !!document.querySelector('[class*="visitor"],[data-testid*="visitor"]');
  const hasBot = /bot detection|botd|isBot|bad bot|browser_automation/i.test(body);
  const hasError = /error|failed|something went wrong/i.test(body);
  const sig = (re) => {
    const m = body.match(re);
    return m ? String(m[1]).replace(/\\s+/g, ' ').trim() : null;
  };
  // Playground smart-signal labels (UI text, not sealed API).
  const signals = {
    visitorId: sig(/Visitor ID is\\s*([A-Za-z0-9]{8,})/i),
    browser: sig(/Browser\\s*(Chrome[\\d .]+|Chromium[\\w -]+|Not Available)/i),
    confidence: sig(/Confidence Score\\s*([\\d.]+)/i),
    bot: sig(/Bot\\s*(Not detected|You are a bad bot[^V]{0,90}|Detected)/i),
    tampering: sig(/Browser Tampering\\s*(Yes[^A-Za-z]{0,8}|No|Not detected)/i),
    vm: sig(/Virtual Machine\\s*(Yes[^A-Za-z]{0,8}|No|Not detected)/i),
    devtools: sig(/Developer Tools\\s*(Yes[^A-Za-z]{0,8}|No|Not detected)/i),
    suspect: sig(/Suspect Score\\s*(\\d+)/i),
    glVersion: (() => {
      try {
        const c = document.createElement('canvas');
        const g = c.getContext('webgl');
        return g ? g.getParameter(0x1F02) : null;
      } catch {
        return null;
      }
    })(),
  };
  // Fingerprint agent global probes
  const fpKeys = keys.filter((k) => /fp|fingerprint/i.test(k));
  return {
    href: location.href,
    title: document.title,
    ready: document.readyState,
    htmlLen: document.documentElement ? document.documentElement.outerHTML.length : 0,
    bodyLen: body.replace(/\\s+/g, ' ').trim().length,
    bodyHead: body.replace(/\\s+/g, ' ').trim().slice(0, 2000),
    hasBailout: !!(document.querySelector('template[data-dgst*="BAILOUT"]') ||
      document.documentElement.innerHTML.includes('BAILOUT_TO_CLIENT_SIDE_RENDERING')),
    hasNext: typeof window.next !== 'undefined',
    nextKeys: window.next ? Object.keys(window.next).slice(0, 20) : null,
    hasWebpackChunk: typeof window.webpackChunk_N_E !== 'undefined',
    webpackChunkLen: chunkLen,
    webpackChunkSample: chunkTypes,
    hasWebpackRequire: typeof window.__webpack_require__ !== 'undefined',
    hasWebpackRequireGlobal: typeof __webpack_require__ !== 'undefined',
    turbo: typeof window.TURBOPACK !== 'undefined',
    keys: keys.slice(0, 40),
    fpKeys,
    scriptCount: scripts.length,
    scripts,
    hasVisitor,
    hasBot,
    hasError,
    signals,
    webdriver: navigator.webdriver,
    ua: (navigator.userAgent || '').slice(0, 100),
    currentScript: document.currentScript
      ? (document.currentScript.src || 'inline').slice(-60)
      : null,
  };
})()`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = {
    profile: "chrome-local-huys-macbook-pro",
    maxSec: parseMaxSecArg(argv, 45),
    url: URL,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--profile") out.profile = argv[++i];
    else if (a === "--url") out.url = argv[++i];
    else if (a === "--max-sec") out.maxSec = Number(argv[++i] || 45);
  }
  return out;
}

function freePort() {
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

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    this.consoles = [];
    this.exceptions = [];
    this.finished = [];
    this.failed = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method === "Runtime.consoleAPICalled") {
        const a = msg.params?.args || [];
        const text = a
          .map((x) => x.value ?? x.description ?? x.type)
          .join(" ");
        this.consoles.push({ type: msg.params?.type, text: String(text).slice(0, 500) });
      } else if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params?.exceptionDetails;
        this.exceptions.push({
          text: d?.text || d?.exception?.description || JSON.stringify(d).slice(0, 400),
          url: d?.url,
          line: d?.lineNumber,
        });
      } else if (msg.method === "Network.responseReceived") {
        const r = msg.params?.response;
        if (r) {
          this.finished.push({
            url: (r.url || "").slice(0, 160),
            status: r.status,
            mime: r.mimeType || "",
          });
        }
      } else if (msg.method === "Network.loadingFailed") {
        this.failed.push({
          url: msg.params?.requestId,
          error: msg.params?.errorText,
          canceled: msg.params?.canceled,
        });
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

async function evalSnap(cdp, sessionId) {
  const r = await cdp.send(
    "Runtime.evaluate",
    { expression: SNAP, returnByValue: true, awaitPromise: false },
    sessionId,
    10000
  );
  if (r.exceptionDetails) {
    return { evalError: r.exceptionDetails.text || r.exceptionDetails.exception?.description };
  }
  return r.result?.value ?? null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(VELORA_BIN)) {
    console.error("missing zig-out/bin/velora — run zig build first");
    process.exit(1);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  let proc = null;
  let stderr = "";
  const flushArtifacts = (tag = "exit") => {
    try {
      writeFileSync(join(OUT_DIR, "stderr.txt"), stderr.slice(-80_000));
      writeFileSync(
        join(OUT_DIR, "HANG.json"),
        JSON.stringify({ tag, stderrLen: stderr.length, at: new Date().toISOString() }, null, 2)
      );
    } catch {}
  };
  const cleanup = () => {
    flushArtifacts("cleanup");
    killProcess(proc);
    proc = null;
  };
  const budget = createProbeBudget(args.maxSec, cleanup);

  try {
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
        "info",
      ],
      {
        cwd: REPO,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      }
    );
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 200_000) stderr = stderr.slice(-150_000);
    });
    proc.on("exit", () => {});

    await waitCdp(endpoint, budget.deadline);
    const ver = await (await fetch(`${endpoint}/json/version`)).json();
    const wsUrl = ver.webSocketDebuggerUrl;
    const ws = await new Promise((res, rej) => {
      const w = new WebSocket(wsUrl);
      w.once("open", () => res(w));
      w.once("error", rej);
    });
    const cdp = new Cdp(ws);
    await cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Network.enable", {}, sessionId).catch(() => {});

    console.log(`[nav] ${args.url}`);
    try {
      await cdp.send(
        "Page.navigate",
        { url: args.url },
        sessionId,
        Math.min(25000, budget.remaining())
      );
    } catch (e) {
      console.log(`[nav] navigate: ${e.message || e}`);
    }

    const polls = [];
    const t0 = Date.now();
    let last = null;
    // Poll up to ~28s within budget
    for (let i = 0; i < 16; i++) {
      if (budget.remaining() < 3000) break;
      await delay(i === 0 ? 1500 : 1800);
      try {
        last = await evalSnap(cdp, sessionId);
        const p = {
          t: Math.round((Date.now() - t0) / 1000),
          bodyLen: last?.bodyLen,
          htmlLen: last?.htmlLen,
          hasNext: last?.hasNext,
          hasWebpackRequire: last?.hasWebpackRequire,
          webpackChunkLen: last?.webpackChunkLen,
          hasVisitor: last?.hasVisitor,
          hasBailout: last?.hasBailout,
          ready: last?.ready,
          bodyHead: last?.bodyHead?.slice(0, 120),
        };
        polls.push(p);
        console.log(JSON.stringify(p));
        if (last?.hasVisitor && last?.bodyLen > 800) break;
      } catch (e) {
        polls.push({ t: Math.round((Date.now() - t0) / 1000), err: String(e.message || e) });
        console.log("poll err", e.message || e);
      }
    }

    // Final HTML dump
    let html = "";
    try {
      const hr = await cdp.send(
        "Runtime.evaluate",
        {
          expression: "document.documentElement ? document.documentElement.outerHTML : ''",
          returnByValue: true,
        },
        sessionId,
        8000
      );
      html = hr.result?.value || "";
    } catch {}

    const report = {
      url: args.url,
      polls,
      last,
      consoles: cdp.consoles.slice(0, 40),
      exceptions: cdp.exceptions.slice(0, 40),
      failedNet: cdp.failed.slice(0, 20),
      finishedJs: cdp.finished.filter((f) => /javascript|script|\.js/i.test(f.mime + f.url)).slice(0, 40),
      finishedAll: cdp.finished.slice(0, 50),
    };
    writeFileSync(join(OUT_DIR, "REPORT.json"), JSON.stringify(report, null, 2));
    writeFileSync(join(OUT_DIR, "DEBUG.json"), JSON.stringify({
      snap: last,
      consoles: cdp.consoles,
      exceptions: cdp.exceptions,
      failed: cdp.failed,
      finished: cdp.finished,
    }, null, 2));
    writeFileSync(join(OUT_DIR, "page.html"), html);
    writeFileSync(join(OUT_DIR, "stderr.txt"), stderr.slice(-80_000));

    console.log("\n=== SUMMARY ===");
    console.log(JSON.stringify({
      bodyLen: last?.bodyLen,
      htmlLen: last?.htmlLen,
      hasNext: last?.hasNext,
      hasWebpackRequire: last?.hasWebpackRequire,
      webpackChunkLen: last?.webpackChunkLen,
      hasVisitor: last?.hasVisitor,
      hasBailout: last?.hasBailout,
      signals: last?.signals,
      consoles: cdp.consoles.length,
      exceptions: cdp.exceptions.length,
      scriptCount: last?.scriptCount,
    }, null, 2));
    if (cdp.exceptions.length) {
      console.log("exceptions:", JSON.stringify(cdp.exceptions.slice(0, 5), null, 2));
    }
    if (cdp.consoles.length) {
      console.log("consoles:", JSON.stringify(cdp.consoles.slice(0, 8), null, 2));
    }

    cdp.close();
    cleanup();
    budget.clear();

    // Pass: visitor signals or substantially hydrated body (not bare shell ~248)
    const ok =
      (last?.hasVisitor === true) ||
      (last?.bodyLen > 600 && last?.hasWebpackRequire === true) ||
      (last?.bodyLen > 1200 && last?.hasNext === true && last?.hasBailout === false);

    process.exit(ok ? 0 : 2);
  } catch (e) {
    console.error("fatal", e);
    cleanup();
    budget.clear();
    process.exit(1);
  }
}

main();
