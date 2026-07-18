/**
 * Single Velora Google Search capture: wire headers, CDP network, page snapshot, HTML.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  copyFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// Prefer repo root node_modules, then velora-run
let WebSocket;
try {
  WebSocket = require("ws");
} catch {
  WebSocket = require(resolve(import.meta.dirname, "../../../../velora-run/node_modules/ws"));
}

const REPO = resolve(import.meta.dirname, "../../..");
const VELORA_BIN = process.env.VELORA_BIN ?? join(REPO, "zig-out/bin/velora");

export const DEFAULT_PROFILE = "chrome-local-huys-macbook-pro";
export const DEFAULT_Q = "velora browser";

export function freePort() {
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

export async function waitCdp(endpoint, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${endpoint}/json/version`)).ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    this.events = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push({ t: Date.now(), ...msg });
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const o = { id, method, params };
      if (sessionId) o.sessionId = sessionId;
      this.ws.send(JSON.stringify(o));
    });
  }
}

const EXTRACT = `(() => {
  const text = (document.body && document.body.innerText) || '';
  const html = document.documentElement ? document.documentElement.outerHTML : '';
  const href = location.href;
  const lower = (text + ' ' + href + ' ' + html.slice(0, 50000)).toLowerCase();
  const q = (s) => document.querySelector(s);
  const qa = (s) => [...document.querySelectorAll(s)];
  const results = qa('#search a h3, #rso h3, div.g h3').slice(0, 12).map((h) => {
    const a = h.closest('a') || h.parentElement?.closest?.('a');
    return { title: (h.textContent || '').trim().slice(0, 140), href: a?.href || null };
  });
  const scripts = qa('script').map((s) => ({
    src: s.src || null,
    type: s.type || null,
    len: (s.textContent || '').length,
    head: (s.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
  }));
  const meta = qa('meta').slice(0, 40).map((m) => ({
    name: m.getAttribute('name') || m.getAttribute('http-equiv') || m.getAttribute('property'),
    content: (m.getAttribute('content') || '').slice(0, 120),
  }));
  return {
    href,
    title: document.title || '',
    readyState: document.readyState,
    bodyLen: text.length,
    htmlLen: html.length,
    signals: {
      sorry: href.includes('/sorry') || lower.includes('unusual traffic') || lower.includes('detected unusual traffic'),
      knitsail: html.includes('knitsail') || html.includes('KGX') || lower.includes('knitsail'),
      enablejs: href.includes('enablejs') || lower.includes('enable javascript'),
      consent: !!(q('form[action*="consent"]') || q('#L2AGLb')),
      recaptcha: !!(q('iframe[src*="recaptcha"]') || q('#recaptcha') || q('.g-recaptcha')),
      rso: !!(q('#rso') || q('#search') || q('#result-stats')),
      searchBox: !!(q('textarea[name="q"]') || q('input[name="q"]')),
    },
    markers: {
      sclm: (html.match(/sclm["']?\\s*[:=]\\s*([^,\\s}<]+)/) || [])[1] || null,
      ussv: html.includes('ussv') ? 'present' : null,
      pageT: (html.match(/pageT["']?\\s*[:=]\\s*([0-9.]+)/) || [])[1] || null,
      sg_ss_in_html: html.includes('sg_ss='),
      sei_in_html: html.includes('sei='),
      scriptCount: scripts.length,
      externalScripts: scripts.filter((s) => s.src).length,
      inlineScripts: scripts.filter((s) => !s.src).length,
    },
    resultStats: (q('#result-stats')?.textContent || '').trim().slice(0, 200),
    results,
    bodyHead: text.replace(/\\s+/g, ' ').trim().slice(0, 600),
    meta,
    scriptsSample: scripts.slice(0, 25),
  };
})()`;

function cookieNames(cookieHeader) {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(/;\s*/)
    .map((p) => p.split("=")[0].trim())
    .filter(Boolean);
}

function classifyHop(url) {
  if (!url || !url.includes("google.") || !url.includes("/search")) return null;
  if (url.includes("sg_ss=")) return "sg_ss";
  if (url.includes("sei=")) return "sei";
  return "initial";
}

function summarizeWireLine(line) {
  let j;
  try {
    j = JSON.parse(line);
  } catch {
    return null;
  }
  const headers = j.headers || [];
  const byName = Object.fromEntries(
    headers.map((h) => [h.name.toLowerCase(), h.value]),
  );
  const cookie = byName.cookie || "";
  const order = (j.headerOrder || []).map((n) => n.toLowerCase());
  return {
    hop: j.hop || classifyHop(j.url),
    url: j.url,
    status: j.status,
    protocol: j.protocol,
    headerCount: j.headerCount ?? headers.length,
    headerOrder: j.headerOrder || [],
    headerOrderNorm: order,
    cookieBytes: cookie.length,
    cookieNames: cookieNames(cookie),
    acceptEncoding: byName["accept-encoding"] || null,
    secFetchSite: byName["sec-fetch-site"] || null,
    secFetchUser: byName["sec-fetch-user"] || null,
    secFetchDest: byName["sec-fetch-dest"] || null,
    secFetchMode: byName["sec-fetch-mode"] || null,
    downlink: byName.downlink || null,
    rtt: byName.rtt || null,
    referer: byName.referer || null,
    userAgent: (byName["user-agent"] || "").slice(0, 160),
    secChUa: byName["sec-ch-ua"] || null,
    hasXBrowser: order.some((n) => n.startsWith("x-browser")),
    hasXClientData: order.includes("x-client-data"),
    hasCacheControl: order.includes("cache-control"),
    hasDownlink: order.includes("downlink"),
    headers: headers.map((h) => ({
      name: h.name,
      value: (h.value || "").length > 200 ? h.value.slice(0, 200) + "…" : h.value,
      valueLen: (h.value || "").length,
    })),
  };
}

function networkFromEvents(events, t0) {
  const reqs = new Map();
  const out = [];
  for (const e of events) {
    const rel = e.t - t0;
    if (e.method === "Network.requestWillBeSent") {
      const p = e.params || {};
      const req = p.request || {};
      const entry = {
        tMs: rel,
        requestId: p.requestId,
        type: p.type,
        method: req.method,
        url: req.url,
        documentURL: p.documentURL,
        initiator: p.initiator?.type,
        headers: req.headers || {},
        hop: classifyHop(req.url),
      };
      reqs.set(p.requestId, entry);
      out.push({ kind: "request", ...entry });
    } else if (e.method === "Network.responseReceived") {
      const p = e.params || {};
      const r = p.response || {};
      const prev = reqs.get(p.requestId);
      out.push({
        kind: "response",
        tMs: rel,
        requestId: p.requestId,
        type: p.type,
        url: r.url,
        status: r.status,
        mimeType: r.mimeType,
        protocol: r.protocol,
        remoteIPAddress: r.remoteIPAddress,
        encodedDataLength: r.encodedDataLength,
        headers: r.headers || {},
        hop: classifyHop(r.url),
        fromRequest: prev
          ? { method: prev.method, type: prev.type, hop: prev.hop }
          : null,
      });
    } else if (e.method === "Network.loadingFinished") {
      const p = e.params || {};
      out.push({
        kind: "finished",
        tMs: rel,
        requestId: p.requestId,
        encodedDataLength: p.encodedDataLength,
      });
    }
  }
  return out;
}

/**
 * @param {{
 *   label: string,
 *   outDir: string,
 *   profile?: string,
 *   url: string,
 *   cookieJarPath?: string | null,
 *   maxSec?: number,
 * }} opts
 */
export async function captureRun(opts) {
  const profile = opts.profile ?? DEFAULT_PROFILE;
  const maxSec = opts.maxSec ?? 22;
  const outDir = opts.outDir;
  mkdirSync(outDir, { recursive: true });

  const wirePath = join(outDir, "wire.ndjson");
  const logPath = join(outDir, "velora.stderr.log");
  const metaPath = join(outDir, "meta.json");
  const networkPath = join(outDir, "network.json");
  const snapshotPath = join(outDir, "snapshot.json");
  const htmlPath = join(outDir, "page.html");
  const wireSummaryPath = join(outDir, "wire-summary.json");

  // Snapshot cookie jar at start
  let jarBefore = null;
  if (opts.cookieJarPath && existsSync(opts.cookieJarPath)) {
    try {
      const arr = JSON.parse(readFileSync(opts.cookieJarPath, "utf8"));
      const google = arr.filter((c) =>
        (c.domain || "").toLowerCase().includes("google"),
      );
      jarBefore = {
        path: opts.cookieJarPath,
        total: arr.length,
        google: google.length,
        names: [...new Set(google.map((c) => c.name))].sort(),
        nidLens: google
          .filter((c) => c.name === "NID")
          .map((c) => ({
            domain: c.domain,
            len: (c.value || "").length,
          })),
        sidPresent: google.some((c) => c.name === "SID"),
        secure1psid: google.some((c) => c.name === "__Secure-1PSID"),
      };
      writeFileSync(
        join(outDir, "cookies-jar-before.json"),
        JSON.stringify(arr, null, 2),
      );
    } catch (e) {
      jarBefore = { error: String(e) };
    }
  } else {
    jarBefore = { path: opts.cookieJarPath || null, missing: true, total: 0 };
    writeFileSync(join(outDir, "cookies-jar-before.json"), "[]\n");
  }

  const port = await freePort();
  const endpoint = `http://127.0.0.1:${port}`;
  const args = [
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--browser-profile",
    profile,
    "--log-level",
    "info",
  ];
  if (opts.cookieJarPath) {
    args.push("--cookie-jar", opts.cookieJarPath);
  }

  const tStart = Date.now();
  const proc = spawn(VELORA_BIN, args, {
    cwd: REPO,
    env: {
      ...process.env,
      VELORA_WIRE_HEADERS: "1",
      VELORA_WIRE_HEADERS_FILE: wirePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  let stdout = "";
  proc.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  proc.stdout.on("data", (d) => {
    stdout += d.toString();
  });

  const okCdp = await waitCdp(endpoint, Math.min(maxSec * 1000, 12_000));
  if (!okCdp) {
    proc.kill("SIGKILL");
    writeFileSync(logPath, stderr + "\n---stdout---\n" + stdout);
    const fail = {
      label: opts.label,
      error: "CDP not ready",
      jarBefore,
      elapsedMs: Date.now() - tStart,
    };
    writeFileSync(metaPath, JSON.stringify(fail, null, 2));
    return fail;
  }

  const ver = await (await fetch(`${endpoint}/json/version`)).json();
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.once("open", r);
    ws.once("error", j);
  });
  const cdp = new Cdp(ws);
  const t0 = Date.now();

  await cdp.send("Target.setDiscoverTargets", { discover: true });
  const { targetId } = await cdp.send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);

  const navStart = Date.now();
  await cdp.send("Page.navigate", { url: opts.url }, sessionId);

  let snapshot = null;
  const deadline = tStart + maxSec * 1000;
  while (Date.now() < deadline - 400) {
    await new Promise((r) => setTimeout(r, 450));
    try {
      const r = await cdp.send(
        "Runtime.evaluate",
        { expression: EXTRACT, returnByValue: true },
        sessionId,
      );
      snapshot = r?.result?.value;
      if (
        snapshot &&
        (snapshot.signals?.rso ||
          snapshot.signals?.sorry ||
          snapshot.htmlLen > 80_000)
      ) {
        break;
      }
    } catch {
      /* mid-nav */
    }
  }

  let html = "";
  try {
    const r = await cdp.send(
      "Runtime.evaluate",
      {
        expression:
          "document.documentElement ? document.documentElement.outerHTML : ''",
        returnByValue: true,
      },
      sessionId,
    );
    html = r?.result?.value || "";
  } catch {}

  writeFileSync(htmlPath, html);
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

  const network = networkFromEvents(cdp.events, t0);
  writeFileSync(networkPath, JSON.stringify(network, null, 2));

  // Wire summary
  let wireLines = [];
  if (existsSync(wirePath)) {
    wireLines = readFileSync(wirePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
  }
  const wireSummary = wireLines.map(summarizeWireLine).filter(Boolean);
  writeFileSync(wireSummaryPath, JSON.stringify(wireSummary, null, 2));

  // Document hops from CDP network
  const docHops = network.filter(
    (n) =>
      n.kind === "request" &&
      (n.type === "Document" || n.hop) &&
      (n.url || "").includes("google.com"),
  );
  const docResponses = network.filter(
    (n) =>
      n.kind === "response" &&
      (n.type === "Document" || n.hop) &&
      (n.url || "").includes("google.com"),
  );

  const cookieLoadLines = stderr
    .split("\n")
    .filter((l) => /Cookie|cookie|loadFromFile|count\s*=/.test(l))
    .slice(0, 40);

  const tier =
    snapshot?.signals?.sorry
      ? "sorry"
      : snapshot?.signals?.rso
        ? "SERP"
        : snapshot?.signals?.knitsail
          ? "knitsail_bootstrap"
          : snapshot?.signals?.enablejs
            ? "enablejs"
            : "other";

  const result = {
    label: opts.label,
    profile,
    url: opts.url,
    endpoint,
    veloraBin: VELORA_BIN,
    startedAt: new Date(tStart).toISOString(),
    elapsedMs: Date.now() - tStart,
    navMs: Date.now() - navStart,
    tier,
    jarBefore,
    cookieLoadLines,
    snapshot,
    wireHopCount: wireSummary.length,
    wireHops: wireSummary.map((w) => ({
      hop: w.hop,
      status: w.status,
      protocol: w.protocol,
      cookieBytes: w.cookieBytes,
      cookieNames: w.cookieNames,
      headerOrderNorm: w.headerOrderNorm,
      secFetchSite: w.secFetchSite,
      secFetchUser: w.secFetchUser,
      downlink: w.downlink,
      rtt: w.rtt,
      acceptEncoding: w.acceptEncoding,
      hasXBrowser: w.hasXBrowser,
      url: (w.url || "").slice(0, 200),
    })),
    cdpDocumentRequests: docHops.map((d) => ({
      tMs: d.tMs,
      hop: d.hop,
      url: (d.url || "").slice(0, 220),
      method: d.method,
      type: d.type,
    })),
    cdpDocumentResponses: docResponses.map((d) => ({
      tMs: d.tMs,
      hop: d.hop,
      status: d.status,
      protocol: d.protocol,
      mimeType: d.mimeType,
      remoteIPAddress: d.remoteIPAddress,
      encodedDataLength: d.encodedDataLength,
      url: (d.url || "").slice(0, 220),
      contentType: d.headers?.["content-type"] || d.headers?.["Content-Type"],
      contentLength:
        d.headers?.["content-length"] || d.headers?.["Content-Length"],
    })),
    htmlLen: html.length,
    htmlPath: "page.html",
    files: {
      wire: "wire.ndjson",
      wireSummary: "wire-summary.json",
      network: "network.json",
      snapshot: "snapshot.json",
      html: "page.html",
      log: "velora.stderr.log",
      jar: "cookies-jar-before.json",
    },
  };

  writeFileSync(metaPath, JSON.stringify(result, null, 2));
  writeFileSync(logPath, stderr + "\n---stdout---\n" + stdout);

  ws.close();
  proc.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 400));
  if (proc.exitCode === null) proc.kill("SIGKILL");

  return result;
}

export function jarPathForProfile(profile) {
  return join(
    process.env.HOME,
    "Library/Application Support/velora",
    profile,
    "Cookies.json",
  );
}
