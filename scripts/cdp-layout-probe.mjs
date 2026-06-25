#!/usr/bin/env node
/** Quick layout probe via CDP — inject HTML or probe current page. */

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");

const PROBE_EXPR = `(() => {
    const rect = (el) => el ? {
        w: el.offsetWidth, h: el.offsetHeight,
        ch: el.clientHeight, cw: el.clientWidth,
        box: (() => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })(),
    } : null;
    const center = document.getElementById("center_col");
    const rcnt = document.getElementById("rcnt");
    const rhs = document.getElementById("rhs");
    return {
        inner: { w: innerWidth, h: innerHeight },
        docEl: rect(document.documentElement),
        body: rect(document.body),
        center_col: rect(center),
        rcnt: rect(rcnt),
        rhs: rect(rhs),
        google_cv: (typeof google !== "undefined" && google.cv && center) ? google.cv(center) : null,
    };
})()`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = { profile: "chrome-local-huys-macbook-pro", html: null, endpoint: null };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--profile") out.profile = argv[++i];
        else if (argv[i] === "--html") out.html = resolve(argv[++i]);
        else if (argv[i] === "--endpoint") out.endpoint = argv[++i];
    }
    return out;
}

async function getFreePort() {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.unref();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
    });
}

async function waitCdp(endpoint) {
    for (let i = 0; i < 80; i += 1) {
        try {
            if ((await fetch(`${endpoint}/json/version`)).ok) return;
        } catch {}
        await delay(100);
    }
    throw new Error(`CDP not ready: ${endpoint}`);
}

class CdpClient {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        ws.on("message", (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                else resolve(msg.result);
            }
        });
    }
    send(method, params = {}, sessionId = null) {
        const id = this.nextId++;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify(payload));
        });
    }
    close() { this.ws.close(); }
}

function loadProfileWindow(profileId) {
    const path = resolve(REPO, "browser/profiles", `${profileId}.json`);
    if (!existsSync(path)) return null;
    const profile = JSON.parse(readFileSync(path, "utf8"));
    return profile.window ?? null;
}

async function applyProfileViewport(client, sessionId, profileId) {
    const win = loadProfileWindow(profileId);
    if (!win?.innerWidth || !win?.innerHeight) return;
    await client.send("Emulation.setDeviceMetricsOverride", {
        width: win.innerWidth,
        height: win.innerHeight,
        deviceScaleFactor: 1,
        mobile: false,
    }, sessionId).catch(() => {});
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    let proc = null;
    let endpoint = args.endpoint;
    if (!endpoint) {
        const port = await getFreePort();
        proc = spawn(VELORA_BIN, [
            "serve", "--host", "127.0.0.1", "--port", String(port),
            "--browser-profile", args.profile, "--log-level", "warn",
        ], { cwd: REPO, stdio: "ignore" });
        endpoint = `http://127.0.0.1:${port}`;
        await waitCdp(endpoint);
    }

    const version = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
    const client = new CdpClient(ws);
    await client.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);
    await applyProfileViewport(client, sessionId, args.profile);

    if (args.html) {
        const html = readFileSync(args.html, "utf8");
        const bytes = Buffer.byteLength(html, "utf8");
        if (bytes < 64_000) {
            const escaped = JSON.stringify(html);
            await client.send("Runtime.evaluate", {
                expression: `document.open();document.write(${escaped});document.close();`,
            }, sessionId);
            await delay(3000);
        } else {
            const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
            await client.send("Page.navigate", { url }, sessionId);
            await delay(2000);
        }
    }

    const result = await client.send("Runtime.evaluate", {
        expression: PROBE_EXPR,
        returnByValue: true,
        awaitPromise: true,
    }, sessionId);

    const probe = result.result?.value;
    const innerW = probe?.inner?.w ?? 0;
    const totalCols = innerW <= 939.98 ? 12 : innerW <= 1163.98 ? 16 : 20;
    const centerCols = Math.min(12, Math.max(8, totalCols - 6));
    const rhsCols = totalCols - 1 - centerCols;
    const expectCenterW = 56 * centerCols - 20;
    const expectRhsW = rhsCols > 0 ? 56 * rhsCols - 20 : 0;
    const centerW = probe?.center_col?.w ?? 0;
    const rhsW = probe?.rhs?.w ?? 0;
    const centerBox = probe?.center_col?.box;
    const rhsBox = probe?.rhs?.box;
    const rhsGap = (centerBox && rhsBox) ? Math.round(rhsBox.x - (centerBox.x + centerBox.w)) : null;

    const checks = [
        { name: "body_ch>=400", ok: (probe?.body?.ch ?? 0) >= 400, v: probe?.body?.ch },
        { name: "results_ch>=100", ok: (probe?.center_col?.ch ?? probe?.rcnt?.ch ?? 0) >= 100, v: probe?.center_col?.ch ?? probe?.rcnt?.ch },
        { name: "errsrp_center_w", ok: Math.abs(centerW - expectCenterW) < 2, v: `${centerW}/${expectCenterW}` },
        { name: "errsrp_rhs_w", ok: rhsCols === 0 || Math.abs(rhsW - expectRhsW) < 2, v: `${rhsW}/${expectRhsW}` },
        { name: "errsrp_rhs_gap", ok: rhsGap == null || Math.abs(rhsGap - 76) < 2, v: rhsGap },
    ];

    console.log(JSON.stringify({ probe, checks, pass: checks.every((c) => c.ok) }, null, 2));
    client.close();
    proc?.kill("SIGTERM");
    process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});