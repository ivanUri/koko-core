#!/usr/bin/env node
/** Capture Velora stderr while navigating Google Search. */
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";

import { REPO, buildSearchUrl, getFreePort, waitCdp, killProc } from "../lib/cdp.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const VELORA = resolve(REPO, "zig-out/bin/velora");

async function main() {
    const port = await getFreePort();
    const logs = [];
    const proc = spawn(VELORA, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-local-huys-macbook-pro",
        "--log-level", "info",
    ], { cwd: REPO });
    proc.stderr.on("data", (d) => logs.push(String(d)));
    proc.stdout.on("data", (d) => logs.push(String(d)));

    try {
        await waitCdp(`http://127.0.0.1:${port}`, 30000);
        const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        const ws = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });

        let id = 1;
        const pending = new Map();
        ws.on("message", (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg);
        });
        const send = (method, params = {}, sessionId = null) => new Promise((res) => {
            const i = id++;
            pending.set(i, res);
            const p = { id: i, method, params };
            if (sessionId) p.sessionId = sessionId;
            ws.send(JSON.stringify(p));
        });

        const { targetId } = await send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
        await send("Runtime.enable", {}, sessionId);
        await send("Page.navigate", { url: buildSearchUrl("test") }, sessionId);
        await delay(30000);
        ws.close();
    } finally {
        killProc(proc);
    }

    const text = logs.join("");
    const outDir = resolve(REPO, "google-search-debug/tmp");
    await mkdir(outDir, { recursive: true });
    await writeFile(resolve(outDir, "velora-nav.log"), text);

    const interesting = text.split("\n").filter((l) =>
        /executing script|eval script|knitsail|google|success = false|SyntaxError|ReferenceError|TypeError/i.test(l));
    console.log(interesting.join("\n") || "(no matching log lines)");
    console.log(`\nFull log: google-search-debug/tmp/velora-nav.log (${text.length} bytes)`);
}

main().catch((e) => { console.error(e); process.exit(2); });