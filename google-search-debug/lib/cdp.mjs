/**
 * CDP helpers for google-search-debug (Velora + Chrome).
 */
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import WebSocket from "ws";

/** Default install paths for Google Chrome (not Chromium / Playwright). */
export const GOOGLE_CHROME_DEFAULT_BIN = process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : process.platform === "win32"
        ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
        : "/usr/bin/google-chrome-stable";

export const CHROME_BIN = process.env.CHROME_BIN || GOOGLE_CHROME_DEFAULT_BIN;
export const DEFAULT_ENDPOINT = process.env.CHROME_CDP || "http://127.0.0.1:9222";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(__dirname, "../..");
export const VELORA_BIN = resolve(REPO, "zig-out/bin/velora");
export const INJECT_FP_PATH = resolve(__dirname, "inject-fingerprint.js");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function normalizeEndpoint(endpoint) {
    return String(endpoint || DEFAULT_ENDPOINT).replace(/\/$/, "");
}

export async function cdpReady(endpoint = DEFAULT_ENDPOINT) {
    try {
        return (await fetch(`${normalizeEndpoint(endpoint)}/json/version`)).ok;
    } catch {
        return false;
    }
}

/** Reject Chromium / Playwright binaries — Google Search baselines need real Chrome. */
export function assertGoogleChromeBin(bin = CHROME_BIN) {
    const path = String(bin || "");
    if (!path) throw new Error("CHROME_BIN is empty");
    if (!existsSync(path)) {
        throw new Error(
            `Google Chrome not found at ${path}. Install Chrome or set CHROME_BIN to the real binary.`,
        );
    }
    const lower = path.toLowerCase();
    if (
        lower.includes("chromium")
        || lower.includes("ms-playwright")
        || lower.includes("playwright")
        || lower.includes("chrome for testing")
    ) {
        throw new Error(
            `Refusing non-Google-Chrome binary: ${path}\nUse "${GOOGLE_CHROME_DEFAULT_BIN}" or set CHROME_BIN.`,
        );
    }
    return path;
}

export async function fetchCdpVersion(endpoint) {
    const base = normalizeEndpoint(endpoint);
    const res = await fetch(`${base}/json/version`);
    if (!res.ok) throw new Error(`CDP /json/version failed: ${base} (${res.status})`);
    return res.json();
}

/** Ensure an existing CDP endpoint is Google Chrome, not Chromium/Playwright. */
export async function assertGoogleChromeCdp(endpoint) {
    const info = await fetchCdpVersion(endpoint);
    const ua = String(info["User-Agent"] || "");
    const browser = String(info.Browser || "");
    if (!browser.startsWith("Chrome/")) {
        throw new Error(`CDP endpoint is not Chrome: Browser=${browser || "?"}`);
    }
    if (/HeadlessChrome/i.test(ua)) {
        throw new Error(
            `CDP endpoint looks like Headless Chromium (User-Agent: ${ua}). Spawn real Google Chrome instead.`,
        );
    }
    if (/Chromium/i.test(ua) && !/Google Chrome/i.test(ua)) {
        throw new Error(
            `CDP endpoint is Chromium, not Google Chrome (User-Agent: ${ua}).`,
        );
    }
    return { ...info, endpoint: normalizeEndpoint(endpoint) };
}

/**
 * Launch a dedicated Google Chrome instance (never Playwright Chromium).
 * Verifies binary path and CDP Browser string after spawn.
 */
export async function spawnChrome(opts = {}) {
    const bin = assertGoogleChromeBin(opts.bin ?? CHROME_BIN);
    const port = Number(opts.port ?? 9222);
    const endpoint = `http://127.0.0.1:${port}`;
    const profile = opts.profileDir || resolve(os.tmpdir(), `velora-google-debug-chrome-${port}`);
    const proc = spawn(bin, [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
    ], { stdio: "ignore" });
    await waitCdp(endpoint, opts.timeoutMs ?? 30_000);
    const version = await assertGoogleChromeCdp(endpoint);
    return { proc, endpoint, profile, port, bin, version };
}

/**
 * Resolve Chrome for Google Search probes: spawn by default, or attach only when verified.
 */
export async function resolveGoogleChromeSession({
    spawn = true,
    attachEndpoint = null,
    port = null,
    profileDir = null,
} = {}) {
    if (spawn) {
        const chromePort = port ?? await getFreePort();
        const launched = await spawnChrome({ port: chromePort, profileDir });
        return { ...launched, spawned: true };
    }
    const endpoint = normalizeEndpoint(attachEndpoint || DEFAULT_ENDPOINT);
    if (!(await cdpReady(endpoint))) {
        throw new Error(`Chrome CDP not ready: ${endpoint}. Use --chrome-spawn (default) or start Google Chrome manually.`);
    }
    const version = await assertGoogleChromeCdp(endpoint);
    return { proc: null, endpoint, profile: null, port: Number(new URL(endpoint).port || 9222), bin: CHROME_BIN, version, spawned: false };
}

export async function getFreePort() {
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

export async function waitCdp(endpoint, ms = 30_000) {
    const t0 = Date.now();
    const base = normalizeEndpoint(endpoint);
    while (Date.now() - t0 < ms) {
        try {
            if ((await fetch(`${base}/json/version`)).ok) return;
        } catch {}
        await delay(100);
    }
    throw new Error(`CDP not ready: ${base}`);
}

export class CdpClient {
    constructor(ws) {
        this.ws = ws;
        this.nextId = 1;
        this.pending = new Map();
        this.events = [];
        ws.on("message", (raw) => {
            const msg = JSON.parse(String(raw));
            if (msg.method) this.events.push(msg);
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

    drainEvents() {
        const out = this.events;
        this.events = [];
        return out;
    }

    close() {
        this.ws.close();
    }
}

export async function connectCdp(endpoint) {
    const version = await (await fetch(`${normalizeEndpoint(endpoint)}/json/version`)).json();
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.once("open", res);
        ws.once("error", rej);
    });
    const client = new CdpClient(ws);
    await client.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});
    const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
    return { client, sessionId, targetId };
}

/**
 * @param {string} profile
 * @param {number} port
 * @param {{ googleChromeTransport?: boolean, chromeCdp?: string, cookieFile?: string, cookieJar?: string }} [opts]
 */
export async function spawnVelora(profile, port, opts = {}) {
    if (!existsSync(VELORA_BIN)) throw new Error("zig build first — zig-out/bin/velora missing");
    const args = [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", profile, "--log-level", "warn",
    ];
    if (opts.cookieJar) args.push("--cookie-jar", opts.cookieJar);
    if (opts.cookieFile) args.push("--cookie", opts.cookieFile);
    if (opts.googleChromeTransport) args.push("--google-chrome-transport");

    const env = { ...process.env, ...(opts.env || {}) };
    if (opts.chromeCdp) {
        env.CHROME_CDP = normalizeEndpoint(opts.chromeCdp);
        // Reuse compare-script Chrome; do not spawn a second instance per sg_ss hop.
        env.VELORA_CHROME_SPAWN = "0";
    }

    const proc = spawn(VELORA_BIN, args, { cwd: REPO, stdio: "ignore", env });
    const endpoint = `http://127.0.0.1:${port}`;
    await waitCdp(endpoint);
    return { proc, endpoint };
}

export function buildSearchUrl(query, { hl = "en", gl = null } = {}) {
    const params = new URLSearchParams({ q: query, hl });
    if (gl) params.set("gl", gl);
    return `https://www.google.com/search?${params}`;
}

export function killProc(proc, signal = "SIGKILL") {
    if (!proc || proc.killed) return;
    try { proc.kill(signal); } catch {}
}

/** Keep document bodies available for Network.getResponseBody (Chrome evicts fast). */
export async function enableNetworkBodyCapture(client, sessionId) {
    await client.send("Network.enable", {
        maxTotalBufferSize: 100 * 1024 * 1024,
        maxResourceBufferSize: 50 * 1024 * 1024,
    }, sessionId);
    await client.send("Network.setCacheDisabled", { cacheDisabled: true }, sessionId);
}

function isDocumentNetworkEvent(type, response) {
    if (type === "Document" || type === "document") return true;
    const mime = String(response?.mimeType || "");
    return mime.startsWith("text/html");
}

/**
 * Fetch document bodies after loadingFinished (Chrome evicts bodies before responseReceived returns).
 * @param {(requestId: string, response: object, html: string|null, err?: string) => void|Promise<void>} onDocumentBody
 */
export function attachDocumentBodyCapture(client, sessionId, onDocumentBody) {
    const pending = new Map();
    const captured = new Set();

    const deliver = async (requestId, response, html, err) => {
        if (captured.has(requestId)) return;
        captured.add(requestId);
        pending.delete(requestId);
        await onDocumentBody(requestId, response, html, err);
    };

    const tryFetchBody = async (requestId, response, deliverErrors) => {
        if (captured.has(requestId)) return false;
        try {
            const bodyRes = await client.send("Network.getResponseBody", { requestId }, sessionId);
            const html = bodyRes.base64Encoded
                ? Buffer.from(bodyRes.body, "base64").toString("utf8")
                : bodyRes.body;
            await deliver(requestId, response, html, null);
            return true;
        } catch (e) {
            if (deliverErrors) {
                await deliver(requestId, response, null, String(e.message || e));
            }
            return false;
        }
    };

    return async (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.sessionId && msg.sessionId !== sessionId) return;

        const p = msg.params || {};
        const requestId = p.requestId;

        if (msg.method === "Network.responseReceived") {
            if (!isDocumentNetworkEvent(p.type, p.response)) return;
            const response = p.response || {};
            pending.set(requestId, response);
            // Chrome evicts hop-1 bodies before loadingFinished; Velora is slower.
            void tryFetchBody(requestId, response, false);
            return;
        }

        if (msg.method === "Network.loadingFailed") {
            const response = pending.get(requestId);
            if (!response || captured.has(requestId)) return;
            const errText = String(p.errorText || p.type || "loadingFailed");
            await deliver(requestId, response, null, errText);
            return;
        }

        if (msg.method !== "Network.loadingFinished") return;
        const response = pending.get(requestId);
        if (!response || captured.has(requestId)) return;
        await tryFetchBody(requestId, response, true);
    };
}