#!/usr/bin/env node
/**
 * Navigate several large sites with --log-dir enabled for log inspection.
 *
 * Usage:
 *   node scripts/log-big-sites.mjs
 *   node scripts/log-big-sites.mjs --run-id my-run --wait-ms 8000
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import {
    DEFAULT_MAX_SEC,
    HANG_EXIT_CODE,
    killProcess,
    startHardLimit,
} from "./lib/cdp-probe-budget.mjs";

const REPO = resolve(".");
const VELORA = join(REPO, "zig-out/bin/velora");
const LOG_BASE = join(REPO, "logs-demo");

const SITES = [
    { name: "example", url: "https://www.example.com/" },
    { name: "github", url: "https://github.com/" },
    { name: "google", url: "https://www.google.com/" },
    { name: "ebay", url: "https://www.ebay.com/" },
    { name: "amazon", url: "https://www.amazon.com/" },
    { name: "bbc", url: "https://www.bbc.com/" },
];

function parseArgs() {
    const out = { runId: null, waitMs: 6000, maxSec: 120 };
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--run-id") out.runId = argv[++i];
        else if (argv[i] === "--wait-ms") out.waitMs = Number(argv[++i]);
        else if (argv[i] === "--max-sec") out.maxSec = Number(argv[++i]);
    }
    if (!out.runId) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        out.runId = `big-sites-${ts}`;
    }
    return out;
}

async function freePort() {
    return new Promise((res, rej) => {
        const s = createServer();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
    });
}

function lineCount(path) {
    if (!existsSync(path)) return 0;
    return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
}

function fileSize(path) {
    if (!existsSync(path)) return 0;
    return statSync(path).size;
}

function sampleLines(path, n = 3) {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").split("\n").filter(Boolean).slice(0, n);
}

function grepSample(path, needle, n = 2) {
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.includes(needle))
        .slice(0, n);
}

const args = parseArgs();
const runDir = join(LOG_BASE, args.runId);
const port = await freePort();
const endpoint = `http://127.0.0.1:${port}`;

let velora = null;
const stopHard = startHardLimit(args.maxSec, (reason) => {
    console.error(`[HANG] ${reason} after ${args.maxSec}s`);
    killProcess(velora);
    process.exit(HANG_EXIT_CODE);
});

velora = spawn(VELORA, [
    "serve",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--log-level", "debug",
    "--log-level-network", "debug",
    "--log-level-js", "info",
    "--log-dir", LOG_BASE,
    "--log-run-id", args.runId,
    "--log-cdp-trace",
], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });

let veloraErr = "";
velora.stderr.on("data", (d) => { veloraErr += String(d); });

for (let i = 0; i < 80; i += 1) {
    try {
        if ((await fetch(`${endpoint}/json/version`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
}

const { webSocketDebuggerUrl } = await (await fetch(`${endpoint}/json/version`)).json();
const ws = new WebSocket(webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });

let id = 0;
const pending = new Map();
ws.on("message", (raw) => {
    const m = JSON.parse(String(raw));
    if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) rej(new Error(m.error.message));
        else res(m.result ?? {});
    }
});

function send(method, params = {}, sessionId = null, timeoutMs = 15000) {
    const mid = ++id;
    return new Promise((res, rej) => {
        pending.set(mid, { res, rej });
        const p = { id: mid, method, params };
        if (sessionId) p.sessionId = sessionId;
        ws.send(JSON.stringify(p));
        setTimeout(() => rej(new Error(`timeout ${method}`)), timeoutMs);
    });
}

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Runtime.enable", {}, sessionId);
await send("Page.enable", {}, sessionId);
await send("Network.enable", {}, sessionId);

const results = [];
for (const site of SITES) {
    const t0 = Date.now();
    try {
        await send("Page.navigate", { url: site.url }, sessionId, 20000);
        await new Promise((r) => setTimeout(r, args.waitMs));
        const title = await send("Runtime.evaluate", {
            expression: "document.title",
            returnByValue: true,
        }, sessionId);
        results.push({
            site: site.name,
            url: site.url,
            ok: true,
            title: title.result?.value ?? "",
            ms: Date.now() - t0,
        });
        console.log(`OK  ${site.name.padEnd(8)} ${site.url} title="${title.result?.value ?? ""}" (${Date.now() - t0}ms)`);
    } catch (err) {
        results.push({ site: site.name, url: site.url, ok: false, err: String(err), ms: Date.now() - t0 });
        console.log(`ERR ${site.name.padEnd(8)} ${site.url} ${err}`);
    }
}

ws.close();
velora.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 1500));
killProcess(velora);
stopHard();

const files = {
    combined: join(runDir, "combined.log"),
    errors: join(runDir, "errors.log"),
    core: join(runDir, "core", "all.log"),
    network: join(runDir, "network", "all.log"),
    protocol: join(runDir, "protocol", "all.log"),
    system: join(runDir, "system", "all.log"),
    jsConsole: join(runDir, "js", "console.log"),
    cdpWire: join(runDir, "protocol", "cdp-wire.log"),
    meta: join(runDir, "meta.json"),
};

console.log("\n=== LOG RUN ===");
console.log("run_dir:", runDir);
console.log("latest ->", join(LOG_BASE, "latest"));
if (existsSync(files.meta)) {
    const meta = JSON.parse(readFileSync(files.meta, "utf8"));
    console.log("meta:", JSON.stringify(meta, null, 2));
}

console.log("\n=== FILE SIZES ===");
for (const [label, path] of Object.entries(files)) {
    console.log(`${label.padEnd(10)} ${lineCount(path)} lines  ${(fileSize(path) / 1024).toFixed(1)} KB  ${path}`);
}

console.log("\n=== NAVIGATE LINES (core) ===");
for (const line of grepSample(files.core, "$msg=navigate", 6)) console.log(line.slice(0, 200));

console.log("\n=== HTTP LINES (network) ===");
for (const line of grepSample(files.network, "$scope=http", 4)) console.log(line.slice(0, 200));

console.log("\n=== CDP WIRE (protocol) ===");
for (const line of sampleLines(files.cdpWire, 2)) console.log(line.slice(0, 200));

console.log("\n=== ERRORS ===");
for (const line of sampleLines(files.errors, 5)) console.log(line.slice(0, 200));
if (lineCount(files.errors) === 0) console.log("(none)");

console.log("\n=== SITE RESULTS ===");
console.log(JSON.stringify(results, null, 2));

console.log("\nView logs:");
console.log(`  node scripts/log-tail.mjs ${LOG_BASE}/latest combined`);
console.log(`  node scripts/log-tail.mjs ${LOG_BASE}/latest network`);
console.log(`  node scripts/log-correlate.mjs ${runDir} --nav-id 1`);