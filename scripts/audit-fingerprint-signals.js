#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const input = process.argv[2];
const output = process.argv[3];

if (!input) {
  console.error("usage: node scripts/audit-fingerprint-signals.js <export.html> [report.json]");
  process.exit(2);
}

const html = fs.readFileSync(path.resolve(input), "utf8");

function readProperty(name, kind, coerce) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const valueClass = kind === "string" ? "json-view--string" :
    kind === "boolean" ? "json-view--boolean" : "json-view--number";
  const pattern = new RegExp(
    `<span class="json-view--property">${escaped}</span>\\s*:\\s*` +
      `<span class="${valueClass}">([^<]+)</span>`,
    "gi",
  );
  const matches = [...html.matchAll(pattern)];
  if (matches.length === 0) return null;
  const value = matches[matches.length - 1][1].trim().replace(/^"|"$/g, "");
  return coerce(value);
}

const report = {
  source: path.resolve(input),
  htmlBytes: Buffer.byteLength(html),
  signals: {
    suspect_score: readProperty("suspect_score", "number", Number),
    tampering_confidence: readProperty("tampering_confidence", "string", String),
    anti_detect_browser: readProperty("anti_detect_browser", "boolean", (value) => value === "true"),
    virtual_machine: readProperty("virtual_machine", "boolean", (value) => value === "true"),
    virtual_machine_ml_score: readProperty("virtual_machine_ml_score", "number", Number),
  },
};

report.complete = Object.values(report.signals).every((value) => value !== null);

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) fs.writeFileSync(path.resolve(output), serialized, "utf8");
process.stdout.write(serialized);
