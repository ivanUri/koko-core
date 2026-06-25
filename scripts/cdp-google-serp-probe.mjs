#!/usr/bin/env node
/**
 * Probe Google SERP layout + bot signals via raw CDP.
 *
 * Usage:
 *   node scripts/cdp-google-serp-probe.mjs --profile chrome-local-huys-macbook-pro
 *   node scripts/cdp-google-serp-probe.mjs --query coingloo.com --cookie code-check/tmp/google-cookies.json
 *   node scripts/cdp-google-serp-probe.mjs --chrome-transport --cookie code-check/tmp/google-cookies.json
 *   node scripts/cdp-google-serp-probe.mjs --html code-check/tmp/google-serp-rcnt.html
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

const SERP_PROBE_EXPR = `(() => {
    const rect = (el) => el ? {
        w: el.offsetWidth, h: el.offsetHeight,
        cw: el.clientWidth, ch: el.clientHeight,
        r: (() => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })(),
    } : null;
    const center = document.getElementById("center_col");
    const rcnt = document.getElementById("rcnt");
    const rhs = document.getElementById("rhs");
    const body = document.body;
    const html = document.documentElement;
    const cv = (typeof google !== "undefined" && google.cv) ? google.cv(center || body) : null;
    return {
        url: location.href,
        title: document.title,
        inner: { w: innerWidth, h: innerHeight },
        docEl: rect(html),
        body: rect(body),
        center_col: rect(center),
        rcnt: rect(rcnt),
        rhs: rect(rhs),
        google_cv_center: cv,
        botguard: typeof botguard !== "undefined",
        botguard_bg: typeof botguard !== "undefined" && typeof botguard.bg === "function",
        pluginsLen: navigator.plugins.length,
        mimeLen: navigator.mimeTypes.length,
        canShare: navigator.canShare?.({ url: "https://example.com" }),
        chrome: !!window.chrome,
        sorry: location.pathname.includes("/sorry"),
    };
})()`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = {
        profile: "chrome-local-huys-macbook-pro",
        endpoint: null,
        port: null,
        query: "coingloo.com",
        settleMs: 6000,
        cookie: null,
        chromeTransport: false,
        html: null,
        keep: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--profile") out.profile = argv[++i];
        else if (a === "--endpoint") out.endpoint = argv[++i];
        else if (a === "--port") out.port = Number(argv[++i]);
        else if (a === "--query") out.query = argv[++i];
        else if (a === "--settle") out.settleMs = Number(argv[++i]);
        else if (a === "--cookie") out.cookie = resolve(argv[++i]);
        else if (a === "--html") out.html = resolve(argv[++i]);
        else if (a === "--chrome-transport") out.chromeTransport = true;
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
        this.events = new Map();
        ws.on("message", (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                else resolve(msg.result);
                return;
            }
            if (msg.method) {
                const handlers = this.events.get(msg.method);
                if (handlers) for (const h of handlers) h(msg.params, msg.sessionId);
            }
        });
    }

    on(method, handler) {
        if (!this.events.has(method)) this.events.set(method, []);
        this.events.get(method).push(handler);
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
    await client.send("Network.enable", {}, sessionId);
    return { client, sessionId, targetId };
}

async function evaluate(client, sessionId, expression, timeoutMs = 8000) {
    const result = await Promise.race([
        client.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: false,
        }, sessionId),
        delay(timeoutMs).then(() => null),
    ]);
    if (!result) return null;
    if (result.exceptionDetails) return null;
    return result.result?.value;
}

async function injectHtml(client, sessionId, html) {
    const bytes = Buffer.byteLength(html, "utf8");
    if (bytes < 64_000) {
        const escaped = JSON.stringify(html);
        await client.send("Runtime.evaluate", {
            expression: `document.open();document.write(${escaped});document.close();`,
        }, sessionId);
    } else {
        const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
        await client.send("Page.navigate", { url }, sessionId);
    }
    await delay(bytes < 64_000 ? 500 : 2000);
}

function classifyHtml(html) {
    const h = String(html || "");
    const title = (h.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.slice(0, 80) ?? null;
    const sorryPage = /<title[^>]*>\s*https?:\/\/www\.google\.com\/sorry/i.test(h)
        || /unusual traffic from your computer/i.test(h);
    return {
        bytes: Buffer.byteLength(h, "utf8"),
        sorry: sorryPage,
        serp: /id="center_col"|SearchResultsPage/.test(h),
        botguard: /botguard/.test(h),
        title,
    };
}

async function spawnVelora(profile, port, opts) {
    const args = [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", profile, "--log-level", "warn",
    ];
    if (opts.cookie) args.push("--cookie", opts.cookie);
    if (opts.chromeTransport) args.push("--google-chrome-transport");

    const env = { ...process.env, VELORA_ROOT: REPO };
    if (opts.chromeTransport && opts.chromeEndpoint) {
        env.CHROME_CDP = opts.chromeEndpoint;
    }

    const proc = spawn(VELORA_BIN, args, { cwd: REPO, stdio: "ignore", env });
    const endpoint = `http://127.0.0.1:${port}`;
    await waitCdp(endpoint);
    return { proc, endpoint };
}

function scoreProbe(probe, meta = {}) {
    const checks = [];
    const add = (name, ok, detail = null) => checks.push({ name, ok, detail });

    if (meta.offline) {
        add("offline_serp", meta.network?.serp === true, meta.network?.title);
    } else if (meta.network) {
        add("network_serp", meta.network.serp, meta.network.title);
        add("network_not_sorry", !meta.network.sorry, meta.network.sorry);
        add("not_sorry", !probe.sorry, probe.url);
    }
    add("body_ch>=400", (probe.body?.ch ?? 0) >= 400, probe.body?.ch);
    const resultsH = probe.center_col?.ch ?? probe.rcnt?.ch ?? 0;
    add("results_ch>=100", resultsH >= 100, resultsH);
    const innerW = probe.inner?.w ?? 0;
    const totalCols = innerW <= 939.98 ? 12 : innerW <= 1163.98 ? 16 : 20;
    const hasRhs = !!(probe.rhs?.w || probe.rhs?.h);
    const centerCols = hasRhs ? Math.min(12, Math.max(8, totalCols - 6)) : (totalCols >= 20 ? 12 : totalCols);
    const rhsCols = hasRhs ? totalCols - 1 - centerCols : 0;
    const expectCenterW = 56 * centerCols - 20;
    const expectRhsW = rhsCols > 0 ? 56 * rhsCols - 20 : 0;
    const centerW = probe.center_col?.w ?? 0;
    const rhsW = probe.rhs?.w ?? 0;
    const centerBox = probe.center_col?.r;
    const rhsBox = probe.rhs?.r;
    const rhsGap = (centerBox && rhsBox) ? Math.round(rhsBox.x - (centerBox.x + centerBox.w)) : null;
    add("errsrp_center_w", Math.abs(centerW - expectCenterW) < 2, `${centerW}/${expectCenterW}`);
    add("errsrp_rhs_w", rhsCols === 0 || Math.abs(rhsW - expectRhsW) < 2, `${rhsW}/${expectRhsW}`);
    add("errsrp_rhs_gap", rhsGap == null || rhsCols === 0 || Math.abs(rhsGap - 76) < 2, rhsGap);
    if (probe.center_col) {
        add("google_cv", (probe.google_cv_center ?? 0) > 0, probe.google_cv_center);
    }
    add("pluginsLen>=5", probe.pluginsLen >= 5, probe.pluginsLen);
    add("canShare", probe.canShare === true, probe.canShare);
    add("chrome", probe.chrome === true, probe.chrome);
    if (probe.botguard) add("botguard", probe.botguard === true, probe.botguard);

    return { checks, pass: checks.every((c) => c.ok) };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.endpoint && !existsSync(VELORA_BIN)) {
        throw new Error("zig build first — zig-out/bin/velora missing");
    }

    let chromeSpawn = null;
    if (args.html && args.chromeTransport) {
        throw new Error("--html is offline mode; do not combine with --chrome-transport");
    }

    if (args.chromeTransport) {
        const { spawnChrome, cdpReady, DEFAULT_ENDPOINT } = await import(
            "../code-check/sites/google/lib/chrome-cdp.mjs"
        );
        if (!(await cdpReady())) {
            chromeSpawn = await spawnChrome({ port: 9222 });
            process.env.CHROME_CDP = chromeSpawn.endpoint;
        } else {
            process.env.CHROME_CDP = DEFAULT_ENDPOINT;
        }
    }

    let proc = null;
    let endpoint = args.endpoint;
    if (!endpoint) {
        const port = args.port ?? await getFreePort();
        ({ proc, endpoint } = await spawnVelora(args.profile, port, {
            cookie: args.cookie,
            chromeTransport: args.chromeTransport,
            chromeEndpoint: process.env.CHROME_CDP,
        }));
        console.log(`velora serve: ${endpoint}  profile=${args.profile}${args.chromeTransport ? "  chrome-transport" : ""}`);
    } else {
        await waitCdp(endpoint.replace(/\/$/, ""));
        console.log(`attach CDP: ${endpoint}`);
    }

    let client = null;
    try {
        const conn = await connectVelora(endpoint);
        client = conn.client;
        await applyProfileViewport(client, conn.sessionId, args.profile);

        const pendingBodies = new Map();
        let capturedHtml = null;
        let capturedMeta = null;

        client.on("Network.responseReceived", (params, evSession) => {
            if (evSession && evSession !== conn.sessionId) return;
            const type = params.type || params.response?.mimeType;
            const url = params.response?.url || "";
            if (params.type !== "Document") return;
            if (!url.includes("google.com")) return;
            pendingBodies.set(params.requestId, {
                url,
                status: params.response?.status,
            });
        });

        client.on("Network.loadingFinished", async (params, evSession) => {
            if (evSession && evSession !== conn.sessionId) return;
            const meta = pendingBodies.get(params.requestId);
            if (!meta || capturedHtml) return;
            try {
                const body = await client.send("Network.getResponseBody", {
                    requestId: params.requestId,
                }, conn.sessionId);
                const html = body.base64Encoded
                    ? Buffer.from(body.body, "base64").toString("utf8")
                    : body.body;
                if (html.length > 1000 && (meta.url.includes("/search") || html.includes("center_col"))) {
                    capturedHtml = html;
                    capturedMeta = { ...meta, ...classifyHtml(html) };
                }
            } catch {}
        });

        let probe = null;
        let probeSource = "live";
        let capturedMetaLocal = null;
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(args.query)}&hl=vi`;

        if (args.html) {
            if (!existsSync(args.html)) throw new Error(`--html not found: ${args.html}`);
            const html = readFileSync(args.html, "utf8");
            capturedMetaLocal = classifyHtml(html);
            await injectHtml(client, conn.sessionId, html);
            await delay(1500);
            probe = await evaluate(client, conn.sessionId, SERP_PROBE_EXPR, 12_000);
            probeSource = "html";
        } else {
            const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(args.query)}&hl=vi`;
            await Promise.race([
                client.send("Page.navigate", { url: searchUrl }, conn.sessionId),
                delay(20_000),
            ]).catch(() => {});
            await delay(args.settleMs);

            probe = await evaluate(client, conn.sessionId, SERP_PROBE_EXPR, 5000);

            if ((!probe || !probe.center_col) && capturedHtml) {
                await injectHtml(client, conn.sessionId, capturedHtml);
                probe = await evaluate(client, conn.sessionId, SERP_PROBE_EXPR, 5000);
                probeSource = "injected";
            }
        }

        if (!probe) {
            probe = {
                url: searchUrl,
                sorry: capturedMeta?.sorry ?? true,
                center_col: null,
                pluginsLen: 0,
                canShare: false,
                chrome: false,
            };
            probeSource = "failed";
        }

        const scored = scoreProbe(probe, {
            network: capturedMeta ?? capturedMetaLocal,
            offline: probeSource === "html",
        });
        const report = {
            probeSource,
            html: args.html,
            network: capturedMeta ?? capturedMetaLocal,
            probe,
            ...scored,
        };
        console.log(JSON.stringify(report, null, 2));

        console.log("\n--- google serp checks ---");
        for (const c of scored.checks) {
            console.log(`${c.ok ? "OK" : "FAIL"}  ${c.name}${c.detail != null ? ` (${c.detail})` : ""}`);
        }

        process.exitCode = scored.pass ? 0 : 1;
    } finally {
        client?.close();
        if (proc && !args.keep) proc.kill("SIGTERM");
        if (chromeSpawn?.proc && !args.keep) {
            try { process.kill(-chromeSpawn.proc.pid, "SIGTERM"); } catch {}
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(2);
});