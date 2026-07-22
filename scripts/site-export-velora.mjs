#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import WebSocket from "ws";

const REPO = resolve(dirname(new URL(import.meta.url).pathname), "..");
const VELORA = resolve(REPO, "zig-out/bin/velora");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

function parseArgs(argv) {
  const opts = {
    url: "https://nike.vn/",
    output: resolve(REPO, "artifacts/site-export/nike.vn.html"),
    report: null,
    profile: "site-export-nike-vn",
    timeoutMs: 90_000,
    quietMs: 2_000,
    minWaitMs: 5_000,
    minImages: 0,
    minElements: 0,
    scroll: false,
    trace: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (!next) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === "--url") opts.url = value();
    else if (arg === "--output") opts.output = resolve(value());
    else if (arg === "--report") opts.report = resolve(value());
    else if (arg === "--profile") opts.profile = value();
    else if (arg === "--timeout-ms") opts.timeoutMs = Number(value());
    else if (arg === "--quiet-ms") opts.quietMs = Number(value());
    else if (arg === "--min-wait-ms") opts.minWaitMs = Number(value());
    else if (arg === "--min-images") opts.minImages = Number(value());
    else if (arg === "--min-elements") opts.minElements = Number(value());
    else if (arg === "--scroll") opts.scroll = true;
    else if (arg === "--trace") opts.trace = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!opts.report) opts.report = opts.output.replace(/\.html?$/i, "") + ".report.json";
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 5_000) throw new Error("--timeout-ms must be >= 5000");
  if (!Number.isFinite(opts.quietMs) || opts.quietMs < 250) throw new Error("--quiet-ms must be >= 250");
  if (!Number.isFinite(opts.minWaitMs) || opts.minWaitMs < 0) throw new Error("--min-wait-ms must be >= 0");
  if (!Number.isInteger(opts.minImages) || opts.minImages < 0) throw new Error("--min-images must be >= 0");
  if (!Number.isInteger(opts.minElements) || opts.minElements < 0) throw new Error("--min-elements must be >= 0");
  return opts;
}

function usage() {
  console.log(`Usage: node scripts/site-export-velora.mjs [options]

  --url URL             page to render (default: https://nike.vn/)
  --output PATH         serialized DOM output
  --report PATH         JSON diagnostics output
  --profile NAME        persistent Velora profile
  --timeout-ms NUMBER   total render timeout (default: 90000)
  --quiet-ms NUMBER     required stable-DOM window (default: 2000)
  --min-wait-ms NUMBER  do not export before this render time (default: 5000)
  --min-images NUMBER   wait for at least this many image elements
  --min-elements NUMBER wait for at least this many DOM elements
  --scroll              scroll progressively to trigger lazy content
  --trace               print failed requests and page exceptions`);
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForServer(endpoint, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) return response.json();
    } catch {}
    await sleep(100);
  }
  throw new Error(`Velora did not start at ${endpoint}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.closed = false;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      if (message.method) {
        for (const listener of this.listeners.get(message.method) || []) listener(message.params || {});
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result || {});
    });
    ws.on("close", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Velora CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  send(method, params = {}, sessionId = null, timeoutMs = 20_000) {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`Velora CDP connection is closed: ${method}`));
    }
    const id = ++this.id;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }
}

async function evaluate(cdp, sessionId, expression, timeoutMs = 20_000) {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: false,
  }, sessionId, timeoutMs);
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "evaluation failed");
  }
  return response.result?.value;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  usage();
  process.exit(0);
}
if (!existsSync(VELORA)) throw new Error(`missing ${VELORA}; run zig build first`);

mkdirSync(dirname(opts.output), { recursive: true });
mkdirSync(dirname(opts.report), { recursive: true });

const port = await freePort();
const endpoint = `http://127.0.0.1:${port}`;
const child = spawn(VELORA, [
  "serve", "--host", "127.0.0.1", "--port", String(port),
  "--browser-profile", opts.profile,
  "--log-level", opts.trace ? "info" : "warn",
], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (chunk) => {
  const text = String(chunk);
  stderr += text;
  if (opts.trace) process.stderr.write(text);
});

let ws;
const failures = [];
const badResponses = [];
const exceptions = [];
const inflight = new Map();
const started = Date.now();
try {
  const version = await waitForServer(endpoint);
  ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((open, reject) => { ws.once("open", open); ws.once("error", reject); });
  const cdp = new Cdp(ws);
  cdp.on("Network.requestWillBeSent", ({ requestId, type, request = {} }) => {
    inflight.set(requestId, { type, url: request.url || "" });
  });
  cdp.on("Network.loadingFinished", ({ requestId }) => inflight.delete(requestId));
  cdp.on("Network.loadingFailed", (event) => {
    inflight.delete(event.requestId);
    failures.push({ type: event.type, errorText: event.errorText, blockedReason: event.blockedReason || null });
  });
  cdp.on("Network.responseReceived", ({ type, response = {} }) => {
    if (Number(response.status) >= 400) badResponses.push({ type, status: response.status, url: response.url });
  });
  cdp.on("Runtime.exceptionThrown", ({ exceptionDetails = {} }) => {
    exceptions.push(exceptionDetails.exception?.description || exceptionDetails.text || "unknown exception");
  });

  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `(() => {
    globalThis.__veloraExport = { errors: [], rejections: [] };
    addEventListener('error', event => globalThis.__veloraExport.errors.push(String(event.error?.stack || event.message || event.error)));
    addEventListener('unhandledrejection', event => globalThis.__veloraExport.rejections.push(String(event.reason?.stack || event.reason)));
  })()` }, sessionId);
  await cdp.send("Page.navigate", { url: opts.url }, sessionId, opts.timeoutMs);

  const deadline = Date.now() + opts.timeoutMs;
  let stableSince = 0;
  let priorSignature = "";
  let snapshot = null;
  let lastSerializedHtml = null;
  let lastScrollAt = 0;
  const serializeExpression = `(() => {
    const html = document.documentElement?.outerHTML || '';
    const base = '<base href="' + String(location.href).replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">';
    return /<head(?:\\s[^>]*)?>/i.test(html)
      ? html.replace(/<head(?:\\s[^>]*)?>/i, match => match + base)
      : html.replace(/<html(?:\\s[^>]*)?>/i, match => match + '<head>' + base + '</head>');
  })()`;
  while (Date.now() < deadline) {
    await sleep(500);
    if (opts.scroll && Date.now() - lastScrollAt >= 1_500) {
      lastScrollAt = Date.now();
      await evaluate(cdp, sessionId, `(() => {
        const step = Math.max(Number(innerHeight) || 768, 600);
        const height = Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
        const next = (Number(scrollY) || 0) + step;
        scrollTo(0, height > 0 && next >= height ? 0 : next);
      })()`, 5_000).catch(() => null);
    }
    snapshot = await evaluate(cdp, sessionId, `(() => {
      const html = document.documentElement?.outerHTML || '';
      const text = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim();
      return {
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        htmlLength: html.length,
        textLength: text.length,
        elementCount: document.querySelectorAll('*').length,
        scriptCount: document.scripts.length,
        imageCount: document.images.length,
        imageComplete: [...document.images].filter(image => image.complete).length,
        images: [...document.images].slice(0, 50).map(image => ({
          src: image.getAttribute('src') || '',
          currentSrc: image.currentSrc || '',
          srcset: image.getAttribute('srcset') || '',
          complete: !!image.complete,
          width: image.width || 0,
          height: image.height || 0,
        })),
        headings: [...document.querySelectorAll('h1,h2')].slice(0, 20).map(el => (el.innerText || '').trim()).filter(Boolean),
        bodyHead: text.slice(0, 500),
        pageErrors: globalThis.__veloraExport || null,
      };
    })()`, 10_000).catch(() => null);
    if (!snapshot) continue;
    const elapsedMs = Date.now() - started;
    const readinessMet = elapsedMs >= opts.minWaitMs &&
      snapshot.imageCount >= opts.minImages &&
      snapshot.elementCount >= opts.minElements;
    // Preserve the first content-complete DOM. Media players and analytics can
    // later monopolize a headless event loop; a final Runtime.evaluate timeout
    // must not discard a snapshot that already met the caller's thresholds.
    if (readinessMet && lastSerializedHtml === null) {
      lastSerializedHtml = await evaluate(cdp, sessionId, serializeExpression, 15_000).catch(() => null);
    }
    const signature = `${snapshot.href}|${snapshot.readyState}|${snapshot.htmlLength}|${snapshot.textLength}|${snapshot.elementCount}`;
    if (signature === priorSignature) {
      if (!stableSince) stableSince = Date.now();
      if (readinessMet && Date.now() - stableSince >= opts.quietMs) break;
    } else {
      priorSignature = signature;
      stableSince = 0;
    }
  }

  const html = await evaluate(cdp, sessionId, serializeExpression, 30_000).catch(error => {
    if (lastSerializedHtml !== null) return lastSerializedHtml;
    throw error;
  });
  const meaningfulInflight = [...inflight.values()].filter(request => request.type !== "Ping");
  const report = {
    requestedUrl: opts.url,
    exportedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    stable: stableSince > 0 && Date.now() - stableSince >= opts.quietMs,
    readiness: {
      minWaitMs: opts.minWaitMs,
      minImages: opts.minImages,
      minElements: opts.minElements,
      met: !!snapshot && Date.now() - started >= opts.minWaitMs && snapshot.imageCount >= opts.minImages && snapshot.elementCount >= opts.minElements,
    },
    snapshot,
    network: { failures, badResponses, inflight: meaningfulInflight.slice(0, 50) },
    exceptions,
    stderrSignals: stripAnsi(stderr).split(/\n\s*\n/).filter(record => /error|warn|not_implemented|leak|fatal/i.test(record)).slice(0, 100),
    output: opts.output,
  };
  writeFileSync(opts.output, `<!doctype html>\n${html}\n`);
  writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
  console.log(`HTML: ${opts.output}`);
  console.log(`Report: ${opts.report}`);
} finally {
  if (ws?.readyState === WebSocket.OPEN) ws.close();
  if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.race([new Promise(done => child.once("exit", done)), sleep(5_000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
