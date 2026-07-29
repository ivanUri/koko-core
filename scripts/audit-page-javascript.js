#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const logPath = path.resolve(process.argv[2] || path.join(root, "export-logs/demo.fingerprint.com.log"));
const cacheDir = path.resolve(process.argv[3] || "/Users/huydev/Library/Application Support/velora/huynew-recapture-20260727/Cache");
const outDir = path.resolve(process.argv[4] || path.join(root, "exports/fingerprint-js-audit"));
const filesDir = path.join(outDir, "files");

fs.mkdirSync(filesDir, { recursive: true });

const sha256 = (body) => crypto.createHash("sha256").update(body).digest("hex");
const safeName = (url, index) => {
  const parsed = new URL(url);
  const base = path.basename(parsed.pathname) || "index.js";
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, "_");
  // Obfuscated cache paths can exceed macOS filename limits.
  const stem = clean.replace(/\.js$/, "").slice(0, 120);
  return `${String(index).padStart(3, "0")}-${stem}-${sha256(url).slice(0, 10)}.js`;
};

function parseVeloraCache(file) {
  const data = fs.readFileSync(file);
  const marker = Buffer.from('{"version":2,"metadata":');
  const metadataOffset = data.lastIndexOf(marker);
  if (metadataOffset < 8) return null;
  let envelope;
  try { envelope = JSON.parse(data.subarray(metadataOffset).toString("utf8")); }
  catch { return null; }
  const metadata = envelope.metadata || {};
  const url = metadata.url;
  if (!url) return null;
  return { url, metadata, body: data.subarray(8, metadataOffset) };
}

function extractBlobWorkers(source) {
  const workers = [];
  const needle = "new Blob([";
  let cursor = 0;
  while ((cursor = source.indexOf(needle, cursor)) >= 0) {
    let i = cursor + needle.length;
    while (/\s/.test(source[i] || "")) i++;
    const quote = source[i];
    if (quote !== "'" && quote !== '"' && quote !== "`") { cursor = i; continue; }
    const start = i++;
    let escaped = false;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === quote) break;
    }
    if (i >= source.length) break;
    const literal = source.slice(start, i + 1);
    let decoded;
    try {
      decoded = JSON.parse(quote === '"' ? literal : `"${literal.slice(1, -1).replace(/"/g, '\\"')}"`);
    } catch {
      decoded = literal.slice(1, -1)
        .replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t")
        .replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (decoded.length > 100) workers.push(decoded);
    cursor = i + 1;
  }
  return workers;
}

const apiPatterns = [
  "navigator.webdriver", "navigator.userAgentData", "getHighEntropyValues", "navigator.plugins",
  "navigator.languages", "navigator.hardwareConcurrency", "navigator.deviceMemory", "navigator.platform",
  "OfflineAudioContext", "AudioContext", "getShaderPrecisionFormat", "getSupportedExtensions",
  "WEBGL_debug_renderer_info", "getContext", "measureText", "toDataURL", "getImageData",
  "getClientRects", "getBoundingClientRect", "getComputedStyle", "CSS.supports", "matchMedia",
  "Object.getOwnPropertyDescriptor", "Object.getOwnPropertyNames", "Function.prototype.toString",
  "RTCPeerConnection", "RTCSctpTransport", "PerformanceEventTiming", "ClipboardItem",
  "indexedDB", "localStorage", "sessionStorage", "cookieEnabled", "BatteryManager",
  "navigator.getBattery", "Intl.DateTimeFormat", "screen.colorDepth", "screen.width",
  "Worker", "SharedWorker", "WebAssembly", "Notification.permission", "permissions.query"
];

function makeIndex(records) {
  return records.map((record) => {
    const source = fs.readFileSync(path.join(outDir, record.file), "utf8");
    const functions = new Set();
    for (const match of source.matchAll(/(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/g)) {
      functions.add(match[1] || match[2]);
      if (functions.size >= 250) break;
    }
    const apis = apiPatterns.filter((api) => source.includes(api));
    return { file: record.file, url: record.url, role: record.role, functions: [...functions], apis };
  });
}

async function main() {
  const log = fs.readFileSync(logPath, "utf8");
  const urls = new Set([...log.matchAll(/src = (https:\/\/[^\s]+\.js(?:\?[^\s]+)?)/g)].map((m) => m[1]));
  const records = [];
  const seenHashes = new Set();

  for (const name of fs.readdirSync(cacheDir).filter((name) => name.endsWith(".cache"))) {
    const parsed = parseVeloraCache(path.join(cacheDir, name));
    if (!parsed) continue;
    const type = String(parsed.metadata.content_type || parsed.metadata.contentType || "");
    const looksJs = type.includes("javascript") || /\/web\/v\d+\//.test(parsed.url) || parsed.body.includes(Buffer.from("FingerprintJS"));
    if (!looksJs) continue;
    const hash = sha256(parsed.body);
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);
    const file = path.join("files", safeName(parsed.url, records.length + 1));
    fs.writeFileSync(path.join(outDir, file), parsed.body);
    records.push({ source: "velora-cache", role: /\/web\/v\d+\//.test(parsed.url) ? "fingerprint-agent" : "cached-script", url: parsed.url, status: parsed.metadata.status || 200, contentType: type, bytes: parsed.body.length, sha256: hash, file });
  }

  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36", accept: "*/*" } });
      const body = Buffer.from(await response.arrayBuffer());
      const hash = sha256(body);
      if (seenHashes.has(hash)) continue;
      seenHashes.add(hash);
      const file = path.join("files", safeName(url, records.length + 1));
      fs.writeFileSync(path.join(outDir, file), body);
      records.push({ source: "network", role: url.includes("/_next/static/") ? "nextjs-chunk" : "script", url, status: response.status, contentType: response.headers.get("content-type") || "", bytes: body.length, sha256: hash, file });
    } catch (error) {
      records.push({ source: "network", role: "download-error", url, error: error.message });
    }
  }

  const agentRecords = records.filter((r) => r.file && r.role === "fingerprint-agent");
  let workerNumber = 0;
  for (const agent of agentRecords) {
    const source = fs.readFileSync(path.join(outDir, agent.file), "utf8");
    for (const worker of extractBlobWorkers(source)) {
      workerNumber++;
      const file = path.join("files", `embedded-blob-worker-${workerNumber}.js`);
      fs.writeFileSync(path.join(outDir, file), worker);
      records.push({ source: "embedded-blob", role: "fingerprint-worker", url: `blob:embedded-in:${agent.url}`, bytes: Buffer.byteLength(worker), sha256: sha256(worker), file });
    }
  }

  const index = makeIndex(records.filter((r) => r.file));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ capturedAt: new Date().toISOString(), logPath, cacheDir, records }, null, 2));
  fs.writeFileSync(path.join(outDir, "function-api-index.json"), JSON.stringify(index, null, 2));
  console.log(JSON.stringify({ outDir, scripts: records.filter((r) => r.file).length, agents: agentRecords.length, blobWorkers: workerNumber, errors: records.filter((r) => r.error).length }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
