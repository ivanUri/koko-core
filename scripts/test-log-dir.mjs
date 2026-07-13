#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const VELORA = resolve("zig-out/bin/velora");
const REPO = resolve(".");
const LOG_BASE = join(REPO, "logs-test");
const RUN_ID = "log-dir-smoke";

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

function kill(proc) {
    if (!proc || proc.killed || proc.exitCode != null) return;
    try { proc.kill("SIGKILL"); } catch {}
}

const port = await freePort();
const endpoint = `http://127.0.0.1:${port}`;
const runDir = join(LOG_BASE, RUN_ID);

const proc = spawn(VELORA, [
    "serve",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--log-level", "debug",
    "--log-dir", LOG_BASE,
    "--log-run-id", RUN_ID,
    "--log-cdp-trace",
], { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });

let stderr = "";
proc.stderr.on("data", (d) => { stderr += String(d); });

const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
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

function send(method, params = {}, sessionId = null) {
    const mid = ++id;
    return new Promise((res, rej) => {
        pending.set(mid, { res, rej });
        const p = { id: mid, method, params };
        if (sessionId) p.sessionId = sessionId;
        ws.send(JSON.stringify(p));
        setTimeout(() => rej(new Error(`timeout ${method}`)), 10000);
    });
}

const { targetId } = await send("Target.createTarget", { url: "about:blank" });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sessionId);
await send("Page.navigate", { url: "about:blank" }, sessionId);
await new Promise((r) => setTimeout(r, 5000));

proc.kill("SIGTERM");
await new Promise((r) => setTimeout(r, 500));
kill(proc);
ws.close();

const checks = [
    ["meta.json", join(runDir, "meta.json")],
    ["combined.log", join(runDir, "combined.log")],
    ["core/all.log", join(runDir, "core", "all.log")],
    ["network/all.log", join(runDir, "network", "all.log")],
    ["protocol/cdp-wire.log", join(runDir, "protocol", "cdp-wire.log")],
    ["js/console.log", join(runDir, "js", "console.log")],
];

let ok = true;
for (const [label, path] of checks) {
    const exists = existsSync(path);
    console.log(`${exists ? "OK" : "MISSING"} ${label}: ${path}`);
    if (!exists) ok = false;
}

if (existsSync(join(runDir, "meta.json"))) {
    const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
    console.log("meta.mode", meta.mode);
    console.log("meta.run_dir", meta.run_dir);
}

if (existsSync(join(runDir, "combined.log"))) {
    const combined = readFileSync(join(runDir, "combined.log"), "utf8");
    const hasChannel = combined.includes("$channel=");
    const cdpWireLines = combined.split("\n").filter((l) => l.includes("cdp-wire")).length;
    console.log(`${hasChannel ? "OK" : "MISSING"} combined has $channel`);
    console.log(`${cdpWireLines > 0 ? "OK" : "MISSING"} combined cdp-wire lines=${cdpWireLines}`);
    if (!hasChannel) ok = false;
}

if (existsSync(join(runDir, "protocol", "cdp-wire.log"))) {
    const wire = readFileSync(join(runDir, "protocol", "cdp-wire.log"), "utf8").trim();
    const wireLines = wire ? wire.split("\n").length : 0;
    console.log(`${wireLines > 0 ? "OK" : "WARN"} cdp-wire.log lines=${wireLines}`);
}

if (existsSync(join(LOG_BASE, "latest"))) {
    console.log("OK latest symlink");
} else {
    console.log("MISSING latest symlink");
    ok = false;
}

if (!stderr.includes("log dir ready")) {
    console.log("MISSING stderr log dir ready");
    ok = false;
} else {
    console.log("OK stderr mirror");
}
const stderrCdp = stderr.split("\n").filter((l) => l.includes("cdp-wire")).length;
const stderrHandle = stderr.split("\n").filter((l) => l.includes("cdp handle")).length;
console.log(`${stderrCdp > 0 ? "OK" : "WARN"} stderr cdp-wire lines=${stderrCdp}`);
console.log(`${stderrHandle > 0 ? "OK" : "WARN"} stderr cdp-handle lines=${stderrHandle}`);
if (stderr.includes("cdp_trace = true") || stderr.includes("cdp_trace=true")) {
    console.log("OK cdp_trace enabled in meta log");
} else {
    console.log("WARN cdp_trace flag not visible in stderr");
}

console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);