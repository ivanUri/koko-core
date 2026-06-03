#!/usr/bin/env node
// Test if HTTP request triggers SIGSEGV

const { spawn } = require("node:child_process");
const { resolve } = require("node:path");

const veloraBin = resolve(__dirname, "../zig-out/bin/velora");
const port = 62032;

console.log("[test] launching velora...");
const proc = spawn(veloraBin, [
    "serve",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--log-level", "info",
], {
    stdio: ["ignore", "ignore", "pipe"],
});

let exited = false;
proc.on("exit", (code, signal) => {
    exited = true;
    console.log(`[test] velora exited: code=${code} signal=${signal}`);
    process.exit(signal === "SIGSEGV" ? 1 : 0);
});

proc.stderr.on("data", (d) => console.log(`[stderr] ${d.toString().trim()}`));

async function test() {
    await new Promise(r => setTimeout(r, 500));
    
    console.log("[test] making HTTP request to /json/version...");
    try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`);
        console.log(`[test] response status: ${res.status}`);
        const data = await res.text();
        console.log(`[test] response body: ${data.substring(0, 100)}`);
    } catch (e) {
        console.log(`[test] request failed: ${e.message}`);
    }
    
    await new Promise(r => setTimeout(r, 1000));
    
    if (!exited) {
        console.log("[test] killing velora...");
        proc.kill("SIGTERM");
    }
}

test().catch(e => {
    console.error(e);
    if (!exited) proc.kill("SIGKILL");
});
