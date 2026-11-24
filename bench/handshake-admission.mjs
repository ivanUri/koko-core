#!/usr/bin/env node

import net from "node:net";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createProbeReport, writeProbeReport } from "./common/probe-report.mjs";

const positional = [];
let output = null;
let holdMs = 800;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--output") output = process.argv[++index];
  else if (argument === "--hold-ms") holdMs = Number(process.argv[++index]);
  else positional.push(argument);
}
const binary = positional[0];
const maxPending = Number(positional[1] ?? 2);
const attempts = Number(positional[2] ?? Math.max(maxPending * 4, 8));
const port = Number(positional[3] ?? 9333);
const maxConnections = Number(positional[4] ?? Math.max(attempts, maxPending));

if (!binary || !Number.isInteger(maxPending) || maxPending < 1 || !Number.isInteger(attempts) || attempts < 1 || !Number.isInteger(maxConnections) || maxConnections < 1 || !Number.isInteger(holdMs) || holdMs < 1) {
  throw new Error("usage: node bench/handshake-admission.mjs <koko-binary> [max-pending] [attempts] [port] [max-connections] [--hold-ms <ms>] [--output <json-path>]");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitReady(child) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Koko exited before ready: ${child.exitCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error("Koko did not become ready");
}

async function status(pid) {
  try {
    const text = await readFile(`/proc/${pid}/status`, "utf8");
    const read = (name) => Number(text.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"))?.[1] ?? null);
    let threadStackKb = 0;
    let stackMapKb = 0;
    let anonymousMapKb = 0;
    let largestAnonymousMapKb = 0;
    let largeAnonymousMapCount = 0;
    let largeAnonymousMapKb = 0;
    const largeAnonymousSizes = [];
    for (const task of await readdir(`/proc/${pid}/task`)) {
      try {
        const taskStatus = await readFile(`/proc/${pid}/task/${task}/status`, "utf8");
        threadStackKb += Number(taskStatus.match(/^VmStk:\s+(\d+)/m)?.[1] ?? 0);
        const maps = await readFile(`/proc/${pid}/task/${task}/maps`, "utf8");
        for (const line of maps.split("\n")) {
          if (!line.includes("[stack")) continue;
          const range = line.split(" ", 1)[0].split("-");
          stackMapKb += (parseInt(range[1], 16) - parseInt(range[0], 16)) / 1024;
        }
      } catch {}
    }
    const maps = await readFile(`/proc/${pid}/maps`, "utf8");
    for (const line of maps.split("\n")) {
      const fields = line.trim().split(/\s+/);
      if (fields.length >= 6) continue;
      const range = fields[0]?.split("-");
      if (!range || range.length !== 2) continue;
      const sizeKb = (parseInt(range[1], 16) - parseInt(range[0], 16)) / 1024;
      anonymousMapKb += sizeKb;
      largestAnonymousMapKb = Math.max(largestAnonymousMapKb, sizeKb);
      if (sizeKb >= 1024) {
        largeAnonymousMapCount += 1;
        largeAnonymousMapKb += sizeKb;
        largeAnonymousSizes.push(sizeKb);
      }
    }
    largeAnonymousSizes.sort((a, b) => b - a);
    return { rssKb: read("VmRSS"), virtualMemoryKb: read("VmSize"), threads: read("Threads"), threadStackKb, stackMapKb, anonymousMapKb, largestAnonymousMapKb, largeAnonymousMapCount, largeAnonymousMapKb, largeAnonymousSizes: largeAnonymousSizes.slice(0, 8) };
  } catch {
    return { rssKb: null, threads: null };
  }
}

function openSocket() {
  return new Promise((resolve, reject) => {
    let closed = false;
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve({ socket, get closed() { return closed; } }));
    socket.once("error", (error) => {
      if (!socket.destroyed) socket.destroy();
      reject(error);
    });
    socket.once("close", () => { closed = true; });
  });
}

const profile = await mkdtemp(join(tmpdir(), "koko-handshake-admission-"));
const child = spawn(binary, [
  "serve", "--host", "127.0.0.1", "--port", String(port),
  "--cdp-max-connections", String(maxConnections),
  "--cdp-max-pending-connections", String(maxPending),
  "--cdp-thread-stack-mb", "4",
  "--user-data-dir", profile,
  "--http-cache-dir", join(profile, "cache"),
  "--log-level", "warn",
], { stdio: ["ignore", "pipe", "pipe"] });
let spawnError = null;
child.once("error", (error) => { spawnError = error; });
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });

const sockets = [];
const startedAt = new Date().toISOString();
const started = performance.now();
try {
  await waitReady(child);
  const before = await status(child.pid);
  const results = await Promise.allSettled(Array.from({ length: attempts }, openSocket));
  for (const result of results) if (result.status === "fulfilled") sockets.push(result.value);
  await sleep(holdMs);
  const pending = sockets.filter((entry) => !entry.closed).length;
  const closed = sockets.length - pending;
  const after = await status(child.pid);
  const report = await createProbeReport({
    probe: "handshake-admission",
    binary,
    startedAt,
    durationMs: performance.now() - started,
    options: { maxConnections, maxPending, attempts, port, holdMs },
    connected: sockets.length,
    pending,
    closed,
    before,
    after,
  });
  console.log(JSON.stringify(report));
  await writeProbeReport(output, report);
  if (pending > maxPending) throw new Error(`pending handshake cap exceeded: ${pending} > ${maxPending}`);
} finally {
  for (const entry of sockets) entry.socket.destroy();
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  await rm(profile, { recursive: true, force: true });
  if (stderr) process.stderr.write(stderr);
}
