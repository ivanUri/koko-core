#!/usr/bin/env node
/**
 * Stress probe: rapid re-navigation to surface lifecycle races (UAF, double-free).
 * Success = Velora process survives all cycles without SIGSEGV/abort.
 *
 * Usage:
 *   node code-check/site-stability/stress-renavigate.mjs
 *   node code-check/site-stability/stress-renavigate.mjs "https://www.bbc.com/news" --cycles 30
 */

import { createServer as createNetServer } from "node:net";
import { spawn } from "node:child_process";
import WebSocket from "ws";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VELORA = resolve(REPO, "zig-out/bin/velora");
const DEFAULT_URL = "https://www.bbc.com/news";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const args = { url: DEFAULT_URL, cycles: 25, settleMs: 1000, port: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--cycles" && argv[i + 1]) args.cycles = Number(argv[++i]);
        else if (a === "--settle-ms" && argv[i + 1]) args.settleMs = Number(argv[++i]);
        else if (a === "--port" && argv[i + 1]) args.port = Number(argv[++i]);
        else if (!a.startsWith("-")) args.url = a;
    }
    return args;
}

async function freePort() {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
    });
}

async function main() {
    const { url, cycles, settleMs } = parseArgs(process.argv);
    const port = parseArgs(process.argv).port ?? (await freePort());
    const endpoint = `http://127.0.0.1:${port}`;

    const proc = spawn(
        VELORA,
        ["serve", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warn"],
        { cwd: REPO, stdio: ["ignore", "pipe", "pipe"] },
    );

    let log = "";
    proc.stderr.on("data", (d) => {
        log += d;
        process.stderr.write(d);
    });
    proc.stdout.on("data", (d) => {
        log += d;
    });

    for (let i = 0; i < 80; i++) {
        try {
            if ((await fetch(`${endpoint}/json/version`)).ok) break;
        } catch {}
        await delay(100);
    }

    const { webSocketDebuggerUrl } = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.once("open", res);
        ws.once("error", rej);
    });

    let id = 0;
    const pending = new Map();
    ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.id && pending.has(m.id)) {
            const { res, rej } = pending.get(m.id);
            pending.delete(m.id);
            m.error ? rej(new Error(m.error.message)) : res(m.result);
        }
    });
    const call = (method, params = {}, sid = null) =>
        new Promise((res, rej) => {
            const mid = ++id;
            pending.set(mid, { res, rej });
            const p = { id: mid, method, params };
            if (sid) p.sessionId = sid;
            ws.send(JSON.stringify(p));
        });

    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    await call("Runtime.enable", {}, sessionId);
    await call("Page.enable", {}, sessionId);

    const waitForLoad = () =>
        new Promise((res) => {
            const onMsg = (raw) => {
                const m = JSON.parse(String(raw));
                if (m.method === "Page.loadEventFired" && m.sessionId === sessionId) {
                    ws.off("message", onMsg);
                    res();
                }
            };
            ws.on("message", onMsg);
            setTimeout(() => {
                ws.off("message", onMsg);
                res();
            }, 30000);
        });

    let ok = 0;
    let fail = 0;

    for (let cycle = 1; cycle <= cycles; cycle++) {
        if (proc.exitCode != null) {
            console.error(`[CRASH] cycle ${cycle}/${cycles} — process exited ${proc.exitCode}`);
            break;
        }
        try {
            await call("Page.navigate", { url }, sessionId);
            await waitForLoad();
            await delay(settleMs);
            ok++;
            if (cycle % 5 === 0) {
                console.error(`[progress] ${cycle}/${cycles} navigations, velora alive`);
            }
        } catch (e) {
            fail++;
            console.error(`[fail] cycle ${cycle}: ${e.message}`);
            if (proc.exitCode != null) break;
        }
    }

    const alive = proc.exitCode == null;
    const passRate = ok / cycles;
    console.error(`\n=== stress-renavigate ===`);
    console.error(`url: ${url}`);
    console.error(`cycles: ${cycles}, ok: ${ok}, fail: ${fail}`);
    console.error(`velora alive: ${alive}`);
    console.error(`pass rate: ${(passRate * 100).toFixed(1)}%`);

    if (!alive) {
        console.error("crash log tail:\n", log.slice(-3000));
        proc.kill("SIGKILL");
        process.exit(1);
    }

    proc.kill("SIGKILL");
    process.exit(passRate >= 0.95 ? 0 : 2);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});