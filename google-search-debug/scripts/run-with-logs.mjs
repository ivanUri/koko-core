#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import WebSocket from "ws";
import { REPO, buildSearchUrl, getFreePort, waitCdp, killProc } from "../lib/cdp.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const VELORA = resolve(REPO, "zig-out/bin/velora");

async function main() {
    const port = await getFreePort();
    const lines = [];
    const proc = spawn(VELORA, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-local-huys-macbook-pro",
        "--log-level", "warn",
    ], { cwd: REPO, env: { ...process.env, VELORA_JS_CALL_LOG: "1" } });
    proc.stderr.on("data", (d) => lines.push(String(d)));
    proc.stdout.on("data", (d) => lines.push(String(d)));

    try {
        await waitCdp(`http://127.0.0.1:${port}`, 20000);
        const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        const ws = new WebSocket(v.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.once("open", r); ws.once("error", j); });
        let id = 1, p = new Map();
        ws.on("message", (d) => { const m = JSON.parse(String(d)); if (m.id && p.has(m.id)) p.get(m.id)(m); });
        const s = (method, params = {}, sid) => new Promise((res) => {
            const i = id++; p.set(i, res);
            ws.send(JSON.stringify({ id: i, method, params, sessionId: sid }));
        });
        const { targetId } = await s("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await s("Target.attachToTarget", { targetId, flatten: true });
        await s("Page.navigate", { url: buildSearchUrl("test") }, sessionId);
        await delay(35000);
        ws.close();
    } finally {
        killProc(proc);
    }

    const text = lines.join("");
    const out = resolve(REPO, "google-search-debug/tmp/velora-warn-js.log");
    await mkdir(resolve(REPO, "google-search-debug/tmp"), { recursive: true });
    await writeFile(out, text);
    const hits = text.split("\n").filter((l) =>
        /eval script|executing script|scriptAdded|knitsail|SyntaxError|ReferenceError|TypeError/i.test(l));
    console.log(hits.join("\n") || "(no hits)");
    console.log(`log bytes: ${text.length} -> ${out}`);
}

main().catch((e) => { console.error(e); process.exit(2); });