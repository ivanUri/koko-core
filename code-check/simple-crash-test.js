#!/usr/bin/env node
// Minimal test to reproduce SIGSEGV

const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const veloraBin = resolve(__dirname, "../zig-out/bin/velora");

console.log("[test] launching velora...");
const proc = spawn(veloraBin, [
    "serve",
    "--host", "127.0.0.1",
    "--port", "62031",
    "--log-level", "info",
], {
    stdio: ["ignore", "pipe", "pipe"],
});

let exited = false;
proc.on("exit", (code, signal) => {
    exited = true;
    console.log(`[test] velora exited: code=${code} signal=${signal}`);
    process.exit(signal === "SIGSEGV" ? 1 : 0);
});

proc.stdout.on("data", (d) => console.log(`[stdout] ${d.toString().trim()}`));
proc.stderr.on("data", (d) => console.log(`[stderr] ${d.toString().trim()}`));

setTimeout(() => {
    if (!exited) {
        console.log("[test] killing after 3s...");
        proc.kill("SIGTERM");
    }
}, 3000);
