#!/usr/bin/env node
"use strict";

/**
 * Capture and compare Chrome/Koko TLS, HTTP/2 and QUIC/HTTP/3 reports.
 *
 * Chrome must already be running with a remote-debugging endpoint. The same
 * Chrome target is used both by capture-fingerprint.js and by this script so
 * the Koko persona comes from the browser that produced the wire baseline.
 *
 * Example:
 *   node scripts/transport-parity-audit.js \
 *     --cdp http://127.0.0.1:9222 \
 *     --profile-id chrome-transport-20260730 \
 *     --runs 5
 *
 * A partial Koko-only run is useful when Chrome capture is temporarily
 * unavailable:
 *   node scripts/transport-parity-audit.js \
 *     --skip-chrome --profile-id chrome-current --runs 1
 */

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_DATE = new Date().toISOString().replace(/[:.]/g, "-");
const DEFAULT_OUT = path.join(ROOT, "exports", "transport-audit", DEFAULT_DATE);

const TARGETS = Object.freeze([
  {
    id: "peet-tcp",
    url: "https://tls.peet.ws/api/all",
    expectedProtocol: "h2",
  },
  {
    id: "browserleaks-tls",
    url: "https://tls.browserleaks.com/json",
    expectedProtocol: "h2",
  },
  {
    id: "browserleaks-quic",
    url: "https://quic.browserleaks.com/fp",
    expectedProtocol: "h3",
  },
]);

function parseArgs(argv) {
  const options = {
    cdp: "http://127.0.0.1:9222",
    profileId: `chrome-transport-${DEFAULT_DATE.slice(0, 10)}`,
    runs: 5,
    out: DEFAULT_OUT,
    userDataDir: path.join("/tmp", "koko-transport-audit"),
    skipChrome: false,
    skipKoko: false,
    reportOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--skip-chrome") options.skipChrome = true;
    else if (arg === "--skip-koko") options.skipKoko = true;
    else if (arg === "--report-only") options.reportOnly = true;
    else if (arg === "--cdp") options.cdp = argv[++i];
    else if (arg === "--profile-id") options.profileId = argv[++i];
    else if (arg === "--runs") options.runs = Number(argv[++i]);
    else if (arg === "--out") options.out = path.resolve(argv[++i]);
    else if (arg === "--user-data-dir") options.userDataDir = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1 || options.runs > 20) {
    throw new Error("--runs must be an integer from 1 to 20");
  }
  if (options.skipChrome && options.skipKoko && !options.reportOnly) {
    throw new Error("cannot skip both Chrome and Koko");
  }
  return options;
}

function requestJson(baseUrl, pathname) {
  const url = new URL(pathname, baseUrl);
  return new Promise((resolve, reject) => {
    const req = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`invalid JSON from ${url}: ${error.message}`));
        }
      });
    });
    req.on("error", reject);
  });
}

function websocketClass() {
  if (typeof globalThis.WebSocket !== "undefined") return globalThis.WebSocket;
  try {
    return require("ws");
  } catch {
    throw new Error("WebSocket unavailable; use Node 22+ or install ws");
  }
}

function connectCdp(webSocketDebuggerUrl) {
  return new Promise((resolve, reject) => {
    const WebSocketImpl = websocketClass();
    const socket = new WebSocketImpl(webSocketDebuggerUrl);
    const browserApi = typeof socket.addEventListener === "function";
    const pending = new Map();
    const listeners = new Set();
    let nextId = 1;

    const on = (event, callback) => {
      if (browserApi) socket.addEventListener(event, callback);
      else socket.on(event, callback);
    };
    const sendRaw = (payload) => socket.send(JSON.stringify(payload));
    const client = {
      send(method, params = {}) {
        const id = nextId++;
        return new Promise((resolveCommand, rejectCommand) => {
          pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
          sendRaw({ id, method, params });
        });
      },
      onEvent(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      close() {
        socket.close();
      },
    };

    on("message", (event) => {
      const raw = event && event.data !== undefined ? event.data : event;
      const text = typeof raw === "string" ? raw : raw.toString();
      const message = JSON.parse(text);
      if (message.id && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
        return;
      }
      if (message.method) {
        for (const listener of listeners) listener(message);
      }
    });
    on("open", () => resolve(client));
    on("error", (error) => reject(error instanceof Error ? error : new Error("CDP socket error")));
  });
}

function waitForMainResponse(cdp, targetUrl, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    let documentResponse = null;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timeout waiting for ${targetUrl}`));
    }, timeoutMs);
    const unsubscribe = cdp.onEvent((message) => {
      if (message.method === "Network.responseReceived") {
        const { response, type, requestId } = message.params;
        if (type === "Document" && response.url === targetUrl) {
          documentResponse = { requestId, response };
        }
        return;
      }
      if (!documentResponse || message.params.requestId !== documentResponse.requestId) return;
      if (message.method === "Network.loadingFinished") {
        clearTimeout(timer);
        unsubscribe();
        resolve(documentResponse);
      } else if (message.method === "Network.loadingFailed") {
        clearTimeout(timer);
        unsubscribe();
        reject(new Error(
          `Chrome failed loading ${targetUrl}: ${message.params.errorText || "unknown error"}`,
        ));
      }
    });
  });
}

function decodeCdpBody(result) {
  if (!result.base64Encoded) return result.body;
  return Buffer.from(result.body, "base64").toString("utf8");
}

function parseJsonText(text, source) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const pre = trimmed.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
    if (!pre) throw new Error(`no JSON payload in ${source}`);
    const decoded = pre[1]
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
    return JSON.parse(decoded);
  }
}

function mkdir(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

function writeJson(filename, value) {
  mkdir(path.dirname(filename));
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`);
}

async function captureChrome(options) {
  const fingerprint = spawnSync(process.execPath, [
    path.join(ROOT, "scripts", "capture-fingerprint.js"),
    options.profileId,
    options.cdp,
  ], { cwd: ROOT, encoding: "utf8" });
  fs.writeFileSync(path.join(options.out, "chrome-fingerprint.log"),
    `${fingerprint.stdout || ""}${fingerprint.stderr || ""}`);
  if (fingerprint.status !== 0) {
    throw new Error(`Chrome fingerprint capture failed (${fingerprint.status})`);
  }

  const targets = await requestJson(options.cdp, "/json/list");
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!page) throw new Error("Chrome CDP has no page target");
  const version = await requestJson(options.cdp, "/json/version");
  writeJson(path.join(options.out, "chrome-version.json"), version);

  const cdp = await connectCdp(page.webSocketDebuggerUrl);
  await cdp.send("Network.enable");
  await cdp.send("Page.enable");
  try {
    for (const target of TARGETS) {
      for (let run = 1; run <= options.runs; run += 1) {
        const pendingResponse = waitForMainResponse(cdp, target.url);
        await cdp.send("Page.navigate", { url: target.url });
        const { requestId, response } = await pendingResponse;
        const bodyResult = await cdp.send("Network.getResponseBody", { requestId });
        const body = decodeCdpBody(bodyResult);
        const directory = path.join(options.out, "chrome", target.id);
        mkdir(directory);
        fs.writeFileSync(path.join(directory, `run-${run}.raw.txt`), body);
        writeJson(path.join(directory, `run-${run}.meta.json`), {
          url: response.url,
          status: response.status,
          protocol: response.protocol,
          remoteIPAddress: response.remoteIPAddress,
          remotePort: response.remotePort,
          headers: response.headers,
          securityDetails: response.securityDetails || null,
        });
        writeJson(path.join(directory, `run-${run}.json`),
          parseJsonText(body, `${target.id} Chrome run ${run}`));
      }
    }
  } finally {
    cdp.close();
  }
}

function ensureKokoProfile(options) {
  const koko = path.join(ROOT, "zig-out", "bin", "koko");
  if (!fs.existsSync(koko)) throw new Error(`Koko binary not found: ${koko}`);
  mkdir(options.userDataDir);
  const profileDir = path.join(options.userDataDir, options.profileId);
  if (fs.existsSync(profileDir)) return;
  const result = spawnSync(koko, [
    "profile", "create",
    "--name", options.profileId,
    "--fingerprint", options.profileId,
    "--user-data-dir", options.userDataDir,
  ], { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Koko profile creation failed: ${result.stderr || result.stdout}`);
  }
}

function captureKoko(options) {
  ensureKokoProfile(options);
  const koko = path.join(ROOT, "zig-out", "bin", "koko");
  const transportProbe = path.join(ROOT, "vendor", "curl-impersonate", "curl_chrome150");
  const fingerprint = JSON.parse(fs.readFileSync(
    path.join(ROOT, "browser", "fingerprints", options.profileId, "fingerprint.json"),
    "utf8",
  ));
  const brands = fingerprint.userAgentData?.brands || [];
  const secChUa = brands
    .map((brand) => `"${brand.brand}";v="${brand.version}"`)
    .join(", ");
  const commonHeaders = [
    "-H", `user-agent: ${fingerprint.navigator.userAgent}`,
    "-H", `sec-ch-ua: ${secChUa}`,
    "-H", `sec-ch-ua-mobile: ${fingerprint.userAgentData?.mobile ? "?1" : "?0"}`,
    "-H", `sec-ch-ua-platform: "${fingerprint.userAgentData?.platform || ""}"`,
    "-H", `accept-language: ${(fingerprint.navigator.languages || ["en-US", "en"])
      .map((language, index) => index === 0 ? language : `${language};q=${(1 - index * 0.1).toFixed(1)}`)
      .join(",")}`,
  ];
  for (const target of TARGETS) {
    for (let run = 1; run <= options.runs; run += 1) {
      const directory = path.join(options.out, "koko", target.id);
      mkdir(directory);
      const smoke = spawnSync(koko, [
        "fetch",
        "--dump", "html",
        "--browser-profile", options.profileId,
        "--user-data-dir", options.userDataDir,
        "--wait-until", "load",
        "--wait-ms", "1000",
        "--terminate-ms", "30000",
        target.url,
      ], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      fs.writeFileSync(path.join(directory, `run-${run}.koko.html`), smoke.stdout || "");
      fs.writeFileSync(path.join(directory, `run-${run}.koko.log`), smoke.stderr || "");
      if (smoke.status !== 0) {
        throw new Error(`Koko ${target.id} run ${run} failed (${smoke.status})`);
      }

      // JSON top-level documents currently serialize as an empty HTML shell.
      // Capture the report through Koko's vendored transport probe instead
      // of treating the empty DOM dump as response data. This exercises the
      // exact patched curl/BoringSSL/ngtcp2/nghttp3 bundle, while the smoke
      // navigation above verifies that the browser runtime can navigate with
      // the captured persona.
      const transport = spawnSync(transportProbe, [
        "-sS",
        target.expectedProtocol === "h3" ? "--http3" : "--http2",
        ...commonHeaders,
        target.url,
      ], {
        cwd: ROOT,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      fs.writeFileSync(path.join(directory, `run-${run}.raw.txt`), transport.stdout || "");
      fs.writeFileSync(path.join(directory, `run-${run}.transport.log`), transport.stderr || "");
      writeJson(path.join(directory, `run-${run}.meta.json`), {
        kokoExitCode: smoke.status,
        kokoSignal: smoke.signal,
        transportExitCode: transport.status,
        transportSignal: transport.signal,
        transportBackend: "vendor/curl-impersonate/curl_chrome150",
        expectedProtocol: target.expectedProtocol,
      });
      if (transport.status !== 0) {
        throw new Error(`Koko transport ${target.id} run ${run} failed (${transport.status})`);
      }
      writeJson(path.join(directory, `run-${run}.json`),
        parseJsonText(transport.stdout, `${target.id} Koko transport run ${run}`));
    }
  }
}

const VOLATILE_KEYS = new Set([
  "client_random",
  "session_id",
  "session_ticket",
  "connection_id",
  "ip",
  "remote_ip",
  "timestamp",
]);

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE_KEYS.has(key.toLowerCase())) continue;
    result[key] = normalize(value[key]);
  }
  return result;
}

function firstDifference(left, right, trail = "$") {
  if (Object.is(left, right)) return null;
  if (typeof left !== typeof right || left === null || right === null) {
    return { path: trail, chrome: left, koko: right };
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return { path: trail, chrome: left, koko: right };
    }
    for (let i = 0; i < left.length; i += 1) {
      const difference = firstDifference(left[i], right[i], `${trail}[${i}]`);
      if (difference) return difference;
    }
    return null;
  }
  if (typeof left === "object") {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
    for (const key of keys) {
      if (!(key in left) || !(key in right)) {
        return { path: `${trail}.${key}`, chrome: left[key], koko: right[key] };
      }
      const difference = firstDifference(left[key], right[key], `${trail}.${key}`);
      if (difference) return difference;
    }
  }
  return typeof left === "object" ? null : { path: trail, chrome: left, koko: right };
}

function compare(options) {
  if (options.skipChrome || options.skipKoko) return;
  const summary = {
    profileId: options.profileId,
    runs: options.runs,
    targets: {},
  };
  for (const target of TARGETS) {
    const targetSummary = [];
    for (let run = 1; run <= options.runs; run += 1) {
      const chrome = normalize(JSON.parse(fs.readFileSync(
        path.join(options.out, "chrome", target.id, `run-${run}.json`), "utf8")));
      const koko = normalize(JSON.parse(fs.readFileSync(
        path.join(options.out, "koko", target.id, `run-${run}.json`), "utf8")));
      writeJson(path.join(options.out, "normalized", "chrome", target.id, `run-${run}.json`), chrome);
      writeJson(path.join(options.out, "normalized", "koko", target.id, `run-${run}.json`), koko);
      const difference = firstDifference(chrome, koko);
      targetSummary.push({ run, equal: difference === null, firstDifference: difference });
    }
    summary.targets[target.id] = targetSummary;
  }
  writeJson(path.join(options.out, "comparison.json"), summary);
  writeMetricReport(options);
}

function getPath(value, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => current?.[key], value);
}

function uniqueMetricValues(options, side, targetId, metricPath) {
  const values = [];
  for (let run = 1; run <= options.runs; run += 1) {
    const report = JSON.parse(fs.readFileSync(
      path.join(options.out, side, targetId, `run-${run}.json`),
      "utf8",
    ));
    const value = getPath(report, metricPath);
    const encoded = typeof value === "string" ? value : JSON.stringify(value);
    if (!values.includes(encoded)) values.push(encoded);
  }
  return values;
}

function writeMetricReport(options) {
  const metrics = [
    ["peet-tcp", "tls.ja4", "TCP JA4"],
    ["peet-tcp", "tls.ja4_r", "TCP JA4_r"],
    ["peet-tcp", "http2.akamai_fingerprint_hash", "HTTP/2 Akamai hash"],
    ["browserleaks-tls", "ja4", "BrowserLeaks TCP JA4"],
    ["browserleaks-tls", "ja4_r", "BrowserLeaks TCP JA4_r"],
    ["browserleaks-tls", "akamai_hash", "BrowserLeaks HTTP/2 hash"],
    ["browserleaks-quic", "ja4", "QUIC JA4"],
    ["browserleaks-quic", "ja4_r", "QUIC JA4_r"],
    ["browserleaks-quic", "h3_hash", "HTTP/3 hash"],
    ["browserleaks-quic", "h3_text", "HTTP/3 settings"],
  ];
  const rows = metrics.map(([targetId, metricPath, label]) => {
    const chrome = uniqueMetricValues(options, "chrome", targetId, metricPath);
    const koko = uniqueMetricValues(options, "koko", targetId, metricPath);
    return {
      targetId,
      metricPath,
      label,
      chrome,
      koko,
      exact: chrome.length === koko.length && chrome.every((value) => koko.includes(value)),
    };
  });
  writeJson(path.join(options.out, "metric-summary.json"), {
    profileId: options.profileId,
    runs: options.runs,
    rows,
    notes: [
      "JA3 hashes are intentionally excluded because Chrome permutes extension order.",
      "A warm Chrome TLS session may add pre_shared_key (0x0029), changing the JA4 extension count.",
      "A warm Chrome QUIC session may add early_data (0x002a), changing the JA4 extension count.",
      "Session-resumption differences must be audited separately from a cold ClientHello mismatch.",
    ],
  });

  const lines = [
    "# Chrome / Koko transport parity",
    "",
    `Profile: \`${options.profileId}\`  `,
    `Runs per target: ${options.runs}`,
    "",
    "| Target | Metric | Exact | Chrome | Koko |",
    "|---|---|---:|---|---|",
  ];
  for (const row of rows) {
    const chrome = row.chrome.join("<br>").replace(/\|/g, "\\|");
    const koko = row.koko.join("<br>").replace(/\|/g, "\\|");
    lines.push(`| ${row.targetId} | ${row.label} | ${row.exact ? "yes" : "no"} | \`${chrome}\` | \`${koko}\` |`);
  }
  lines.push(
    "",
    "Notes:",
    "",
    "- JA3 is not a stable equality gate because Chrome deliberately permutes TLS extension order.",
    "- Chrome session resumption adds `pre_shared_key` (`0x0029`) to TCP TLS.",
    "- Chrome QUIC resumption can add `early_data` (`0x002a`).",
    "- Compare cold handshakes separately from warm/resumed handshakes.",
    "",
  );
  fs.writeFileSync(path.join(options.out, "REPORT.md"), `${lines.join("\n")}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.reportOnly) {
    compare(options);
    console.log(options.out);
    return;
  }
  mkdir(options.out);
  writeJson(path.join(options.out, "manifest.json"), {
    capturedAt: new Date().toISOString(),
    profileId: options.profileId,
    cdp: options.cdp,
    runs: options.runs,
    userDataDir: options.userDataDir,
    targets: TARGETS,
    chromeCaptured: !options.skipChrome,
    kokoCaptured: !options.skipKoko,
  });
  if (!options.skipChrome) await captureChrome(options);
  if (!options.skipKoko) captureKoko(options);
  compare(options);
  console.log(options.out);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
