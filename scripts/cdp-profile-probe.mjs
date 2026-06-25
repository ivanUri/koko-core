#!/usr/bin/env node
/**
 * Probe a Velora browser profile via raw CDP (no SDK).
 *
 * Usage:
 *   node scripts/cdp-profile-probe.mjs --profile chrome-local-huys-macbook-pro
 *   node scripts/cdp-profile-probe.mjs --endpoint http://127.0.0.1:57100
 */

import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");
const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");

const FINGERPRINT_EXPR = `(() => {
    const uad = navigator.userAgentData;
    return {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        languages: [...navigator.languages],
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory ?? null,
        vendor: navigator.vendor,
        brands: uad?.brands || [],
        uaPlatform: uad?.platform || null,
        screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio },
        webgl: (() => {
            const c = document.createElement("canvas");
            const gl = c.getContext("webgl");
            if (!gl) return null;
            const dbg = gl.getExtension("WEBGL_debug_renderer_info");
            return {
                vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
                renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
            };
        })(),
        webdriver: navigator.webdriver,
        plugins: [...navigator.plugins].map((p) => p.name),
    };
})()`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = { profile: "chrome-local-huys-macbook-pro", endpoint: null, port: null, keep: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--profile") out.profile = argv[++i];
        else if (a === "--endpoint") out.endpoint = argv[++i];
        else if (a === "--port") out.port = Number(argv[++i]);
        else if (a === "--keep") out.keep = true;
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

async function waitCdp(endpoint, tries = 80) {
    for (let i = 0; i < tries; i += 1) {
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

    close() {
        this.ws.close();
    }
}

async function connectVelora(endpoint) {
    const version = await (await fetch(`${endpoint}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.once("open", res);
        ws.once("error", rej);
    });
    const client = new CdpClient(ws);
    await client.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    await client.send("Page.enable", {}, sessionId);
    await client.send("Runtime.enable", {}, sessionId);
    return { client, sessionId, targetId };
}

async function evaluate(client, sessionId, expression) {
    const result = await client.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
    }, sessionId);
    if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
    }
    return result.result?.value;
}

async function spawnVelora(profile, port) {
    const proc = spawn(VELORA_BIN, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", profile, "--log-level", "warn",
    ], { cwd: REPO, stdio: "ignore" });
    const endpoint = `http://127.0.0.1:${port}`;
    await waitCdp(endpoint);
    return { proc, endpoint };
}

function loadProfileExpectations(profileId) {
    const path = resolve(REPO, `browser/profiles/${profileId}.json`);
    if (!existsSync(path)) return null;
    const doc = JSON.parse(readFileSync(path, "utf8"));
    return {
        userAgent: doc.navigator?.userAgent,
        languages: doc.navigator?.languages,
        hardwareConcurrency: doc.navigator?.hardwareConcurrency,
        deviceMemory: doc.navigator?.deviceMemory,
        screen: doc.screen ? {
            w: doc.screen.width,
            h: doc.screen.height,
            dpr: doc.screen.devicePixelRatio,
        } : null,
        webgl: doc.webgl ? {
            vendor: doc.webgl.unmaskedVendor,
            renderer: doc.webgl.unmaskedRenderer,
        } : null,
    };
}

function compareField(name, got, expected) {
    const ok = JSON.stringify(got) === JSON.stringify(expected);
    return { name, ok, got, expected };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.endpoint && !existsSync(VELORA_BIN)) {
        throw new Error("zig build first — zig-out/bin/velora missing");
    }

    let proc = null;
    let endpoint = args.endpoint;
    if (!endpoint) {
        const port = args.port ?? await getFreePort();
        ({ proc, endpoint } = await spawnVelora(args.profile, port));
        console.log(`velora serve: ${endpoint}  profile=${args.profile}`);
    } else {
        await waitCdp(endpoint.replace(/\/$/, ""));
        console.log(`attach CDP: ${endpoint}`);
    }

    let client = null;
    try {
        const conn = await connectVelora(endpoint);
        client = conn.client;
        await client.send("Page.navigate", { url: "about:blank" }, conn.sessionId);
        await delay(400);

        const fp = await evaluate(client, conn.sessionId, FINGERPRINT_EXPR);
        const version = await (await fetch(`${endpoint}/json/version`)).json();

        const expected = loadProfileExpectations(args.profile);
        const checks = expected ? [
            compareField("userAgent", fp.userAgent, expected.userAgent),
            compareField("languages", fp.languages, expected.languages),
            compareField("hardwareConcurrency", fp.hardwareConcurrency, expected.hardwareConcurrency),
            compareField("deviceMemory", fp.deviceMemory, expected.deviceMemory),
            compareField("screen", fp.screen, expected.screen),
            compareField("webgl.vendor", fp.webgl?.vendor, expected.webgl?.vendor),
            compareField("webgl.renderer", fp.webgl?.renderer, expected.webgl?.renderer),
        ] : [];

        const report = {
            cdp: {
                browser: version.Browser,
                protocolVersion: version["Protocol-Version"],
                webSocketDebuggerUrl: version.webSocketDebuggerUrl,
            },
            fingerprint: fp,
            checks,
            pass: checks.every((c) => c.ok),
        };

        console.log(JSON.stringify(report, null, 2));

        if (checks.length) {
            console.log("\n--- profile match ---");
            for (const c of checks) {
                console.log(`${c.ok ? "OK" : "FAIL"}  ${c.name}`);
                if (!c.ok) console.log(`      got:      ${JSON.stringify(c.got)}`);
                if (!c.ok) console.log(`      expected: ${JSON.stringify(c.expected)}`);
            }
        }

        process.exitCode = report.pass === false ? 1 : 0;
    } finally {
        client?.close();
        if (proc && !args.keep) proc.kill("SIGTERM");
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});