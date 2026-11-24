#!/usr/bin/env node

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { connectCdp, waitForJson } from "./common/cdp.mjs";
import { createProbeReport, writeProbeReport } from "./common/probe-report.mjs";

const positional = [];
let output = null;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--output") output = process.argv[++index];
  else positional.push(argument);
}
const binary = positional[0];
const maxConnections = Number(positional[1] ?? 2);
const attempts = Number(positional[2] ?? maxConnections + 2);
const port = Number(positional[3] ?? 9343);
if (!binary || !Number.isInteger(maxConnections) || maxConnections < 1 || !Number.isInteger(attempts) || attempts < 1) {
  throw new Error("usage: node bench/active-admission.mjs <koko-binary> [max-connections] [attempts] [port] [--output <json-path>]");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profile = await mkdtemp(join(tmpdir(), "koko-active-admission-"));
const child = spawn(binary, [
  "serve", "--host", "127.0.0.1", "--port", String(port),
  "--cdp-max-connections", String(maxConnections),
  "--cdp-max-pending-connections", String(attempts),
  "--cdp-thread-stack-mb", "4",
  "--user-data-dir", profile,
  "--http-cache-dir", join(profile, "cache"),
  "--log-level", "warn",
], { stdio: ["ignore", "pipe", "pipe"] });

let spawnError = null;
let stderr = "";
child.once("error", (error) => { spawnError = error; });
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
const clients = [];
const startedAt = new Date().toISOString();
const started = performance.now();
try {
  if (spawnError) throw spawnError;
  const version = await waitForJson(`http://127.0.0.1:${port}/json/version`, 10_000);
  const results = await Promise.allSettled(Array.from({ length: attempts }, () => connectCdp(version.webSocketDebuggerUrl, 10_000)));
  for (const result of results) if (result.status === "fulfilled") clients.push(result.value);
  await sleep(250);

  // A socket can complete the WebSocket upgrade before the server rejects it
  // for the active-session quota. Probe the CDP path after the upgrade so the
  // result measures usable upgraded sessions rather than TCP sockets.
  const probes = await Promise.allSettled(clients.map((client) => client.send("Target.getTargets", {})));
  const usable = probes.filter((result) => result.status === "fulfilled").length;
  const report = await createProbeReport({
    probe: "active-admission",
    binary,
    startedAt,
    durationMs: performance.now() - started,
    options: { maxConnections, attempts, port },
    opened: clients.length,
    usable,
    rejected: attempts - usable,
  });
  console.log(JSON.stringify(report));
  await writeProbeReport(output, report);
  if (usable > maxConnections) throw new Error(`active connection cap exceeded: ${usable} > ${maxConnections}`);
  if (usable === 0) throw new Error("active admission rejected every usable session");
} finally {
  await Promise.allSettled(clients.map((client) => client.close()));
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  await rm(profile, { recursive: true, force: true });
  if (stderr) process.stderr.write(stderr);
}
