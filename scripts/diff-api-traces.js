#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const leftPath = process.argv[2];
const rightPath = process.argv[3];
if (!leftPath || !rightPath) {
  console.error("Usage: node scripts/diff-api-traces.js <chrome.json> <velora.json>");
  process.exit(1);
}

function aggregate(file) {
  const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
  const totals = new Map();
  for (const realm of artifact.realms || []) {
    for (const event of realm.trace?.events || []) {
      const resultType = event.result?.type || event.error?.name || "-";
      const key = `${event.api}\t${event.phase}\t${resultType}`;
      const current = totals.get(key) || { count: 0, duration: 0, durationCount: 0 };
      current.count++;
      if (typeof event.duration === "number") {
        current.duration += event.duration;
        current.durationCount++;
      }
      totals.set(key, current);
    }
  }
  return totals;
}

const left = aggregate(leftPath);
const right = aggregate(rightPath);
const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
console.log("api\tphase\tresult\tchrome_count\tvelora_count\tchrome_avg_ms\tvelora_avg_ms");
for (const key of keys) {
  const a = left.get(key) || { count: 0, duration: 0, durationCount: 0 };
  const b = right.get(key) || { count: 0, duration: 0, durationCount: 0 };
  const avg = (item) => item.durationCount ? (item.duration / item.durationCount).toFixed(3) : "-";
  const avgNumber = (item) => item.durationCount ? item.duration / item.durationCount : null;
  const avgA = avgNumber(a);
  const avgB = avgNumber(b);
  const timingDiffers = avgA !== null && avgB !== null && Math.abs(avgA - avgB) >= 0.1;
  if (a.count === b.count && !timingDiffers) continue;
  console.log(`${key}\t${a.count}\t${b.count}\t${avg(a)}\t${avg(b)}`);
}
