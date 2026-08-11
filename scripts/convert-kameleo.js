#!/usr/bin/env node
"use strict";

// Convert a decoded Kameleo profile into Koko's self-contained fingerprint
// folder. Raw Kameleo files are never modified.

const fs = require("node:fs");
const path = require("node:path");

const [, , sourceDir = "decoded_view", requestedId] = process.argv;
const root = path.resolve(__dirname, "..");
const source = path.resolve(sourceDir);

function read(name) {
  const file = path.join(source, name);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function findSource(suffix) {
  const file = fs.readdirSync(source).find((name) => name.endsWith(suffix));
  if (!file) throw new Error(`Missing Kameleo source file (*${suffix})`);
  return read(file);
}

function first(...values) {
  return values.find((v) => v !== undefined && v !== null && v !== "");
}

function normalizeLanguages(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === "string") return value.split(",").map((x) => x.trim()).filter(Boolean);
  return [];
}

function normalizeUaData(ua) {
  const m = ua?.metadata || {};
  return {
    brands: m.brandVersionList || [],
    mobile: Boolean(m.mobile),
    platform: first(m.platform, ""),
    platformVersion: first(m.platformVersion, ""),
    architecture: first(m.architecture, ""),
    bitness: first(m.bitness, ""),
    model: first(m.model, ""),
    uaFullVersion: first(m.fullVersion, ""),
    fullVersionList: m.brandFullVersionList || [],
    formFactors: m.formFactors || [],
    wow64: Boolean(m.wow64),
  };
}

function normalizeWebgl(value) {
  if (!value || typeof value !== "object") return null;
  const get = (key, ...aliases) => first(value[key], ...aliases.map((x) => value[x]));
  return {
    vendor: get("7936", "vendor"),
    renderer: get("7937", "renderer"),
    unmaskedVendor: get("37445", "unmaskedVendor"),
    unmaskedRenderer: get("37446", "unmaskedRenderer"),
  };
}

function main() {
  const opts = findSource("_opts.json");
  const bin = findSource("_profile_bin.json");
  const fp = bin.Fingerprint || {};
  const ua = opts.userAgent || {};
  const id = requestedId || `kameleo-${fp.Id || bin.Id || "profile"}`.replace(/[^A-Za-z0-9._-]/g, "-");
  const languages = normalizeLanguages(first(opts.languages, opts.language));
  const screen = opts.screen || {};
  const webgl = normalizeWebgl(opts.webgl);
  const version = Number(fp.Browser?.Major || (ua.full || ua.reduced || "").match(/Chrome\/(\d+)/)?.[1] || 0);

  if (!ua.full && !ua.reduced) throw new Error("Kameleo profile has no userAgent");
  if (!screen.width || !screen.height) throw new Error("Kameleo profile has no screen dimensions");

  const out = path.join(root, "browser", "fingerprints", id);
  const staging = `${out}.staging-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, "assets"), { recursive: true });

  const definition = {
    version: 1,
    id,
    mode: "antidetect",
    capturedAt: new Date().toISOString(),
    capturedFrom: "kameleo-decoded",
    transport: { impersonate: `chrome${version || 146}` },
    navigator: {
      userAgent: first(ua.full, ua.reduced),
      platform: first(opts.platform, fp.Os?.Platform, "Win32"),
      languages,
      hardwareConcurrency: Number(opts.hardwareConcurrency || bin.HardwareConcurrency?.Extra || 0),
      deviceMemory: Number(opts.deviceMemory || bin.DeviceMemory?.Extra || 0),
      maxTouchPoints: Number(opts.maxTouchPoints || 0),
      vendor: "Google Inc.",
      pdfViewerEnabled: true,
      appVersion: first(ua.full, ua.reduced),
    },
    userAgentData: normalizeUaData(ua),
    plugins: [],
    screen: {
      width: Number(screen.width),
      height: Number(screen.height),
      availWidth: Number(screen.availWidth || screen.width),
      availHeight: Number(screen.availHeight || screen.height),
      devicePixelRatio: Number(screen.devicePixelRatio || 1),
      colorDepth: Number(screen.colorDepth || 24),
      pixelDepth: Number(screen.colorDepth || 24),
      touch: Number(opts.maxTouchPoints || 0) > 0,
    },
    window: null,
    timezone: first(opts.timezone, "UTC"),
    locale: first(opts.language, "en-US"),
    timezoneOffset: 0,
    webgl: webgl || {},
    fontsFile: "",
    _source: {
      provider: "kameleo",
      sourceId: fp.Id || bin.Id || "",
      sourceDirectory: path.relative(root, source),
      unsupported: ["canvas", "audio", "dom-baselines", "storage"],
    },
  };

  fs.writeFileSync(path.join(staging, "fingerprint.json"), JSON.stringify(definition, null, 2));
  fs.writeFileSync(path.join(staging, "assets", `${id}-kameleo-options.json`), JSON.stringify(opts, null, 2));
  fs.writeFileSync(path.join(staging, "assets", `${id}-kameleo-raw-profile.json`), JSON.stringify(bin, null, 2));

  JSON.parse(fs.readFileSync(path.join(staging, "fingerprint.json"), "utf8"));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const backup = `${out}.previous-${process.pid}`;
  if (fs.existsSync(out)) fs.renameSync(out, backup);
  fs.renameSync(staging, out);
  if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
  console.log(`Converted Kameleo profile -> ${path.relative(root, out)}`);
}

main();
