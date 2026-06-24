#!/usr/bin/env node
// Deep environment audit: what does Google see in Velora vs real Chrome?
//
// Usage: node code-check/sites/google/env-audit.mjs
//        node code-check/sites/google/env-audit.mjs --chrome-port 9222

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const OUT = resolve(repoRoot, "code-check/tmp/env-audit");
const SEARCH = "https://www.google.com/search?q=velora&hl=en";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const DEEP_PROBE = `(() => {
    const r = (fn, fb = null) => { try { return fn(); } catch (e) { return fb ?? String(e); } };
    const nav = navigator;
    const uad = nav.userAgentData;
    const canvas = r(() => {
        const c = document.createElement("canvas");
        c.width = 240; c.height = 60;
        const ctx = c.getContext("2d");
        ctx.textBaseline = "top";
        ctx.font = "14px Arial";
        ctx.fillStyle = "#f60";
        ctx.fillRect(0, 0, 120, 20);
        ctx.fillStyle = "#069";
        ctx.fillText("velora-audit", 2, 2);
        return c.toDataURL().slice(-24);
    });
    const webgl = r(() => {
        const c = document.createElement("canvas");
        const gl = c.getContext("webgl");
        if (!gl) return null;
        const dbg = gl.getExtension("WEBGL_debug_renderer_info");
        return {
            vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
            renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        };
    });
    const chromeObj = window.chrome;
    return {
        url: location.href,
        sorry: location.href.includes("/sorry"),
        hasSei: location.href.includes("sei="),
        hasSgSs: location.href.includes("sg_ss="),
        webdriver: nav.webdriver,
        ua: nav.userAgent,
        platform: nav.platform,
        vendor: nav.vendor,
        languages: [...(nav.languages || [])],
        language: nav.language,
        hardwareConcurrency: nav.hardwareConcurrency,
        deviceMemory: nav.deviceMemory ?? null,
        maxTouchPoints: nav.maxTouchPoints,
        pdfViewerEnabled: nav.pdfViewerEnabled ?? null,
        plugins: nav.plugins ? [...nav.plugins].map((p) => p.name) : [],
        mimeTypes: nav.mimeTypes ? nav.mimeTypes.length : 0,
        userAgentData: uad ? {
            brands: uad.brands,
            mobile: uad.mobile,
            platform: uad.platform,
            architecture: r(() => uad.getHighEntropyValues(["architecture"]).then((v) => v.architecture)),
        } : null,
        chrome: {
            type: typeof chromeObj,
            keys: chromeObj ? Object.keys(chromeObj).sort() : [],
            loadTimes: typeof chromeObj?.loadTimes,
            csi: typeof chromeObj?.csi,
            runtime: typeof chromeObj?.runtime,
        },
        screen: {
            w: screen.width, h: screen.height,
            aw: screen.availWidth, ah: screen.availHeight,
            dpr: devicePixelRatio,
            colorDepth: screen.colorDepth,
        },
        window: {
            outer: [outerWidth, outerHeight],
            inner: [innerWidth, innerHeight],
            devicePixelRatio,
        },
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        canvasTail: canvas,
        webgl,
        permissionsQuery: r(() => navigator.permissions.query({ name: "notifications" }).then((s) => s.state)),
        connection: nav.connection ? { effectiveType: nav.connection.effectiveType, rtt: nav.connection.rtt } : null,
        scheduling: typeof scheduling !== "undefined",
        trustedClick: r(() => {
            let trusted = null;
            const b = document.createElement("button");
            b.onclick = (e) => { trusted = e.isTrusted; };
            b.click();
            return trusted;
        }),
        errorStackHasCdp: r(() => {
            try { null.x(); } catch (e) { return /devtools|cdp|puppeteer|playwright|selenium/i.test(e.stack || ""); }
        }, false),
        documentElementAttrs: [...document.documentElement.attributes].map((a) => a.name),
        scripts: [...document.scripts].length,
        hits: document.querySelectorAll("#search .g h3, .MjjYud h3").length,
    };
})()`;

function parseArgs(argv) {
    const out = { chromePort: null };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--chrome-port") out.chromePort = Number(argv[++i]);
    }
    return out;
}

async function getFreePort() {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.unref();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
    });
}

async function spawnVelora() {
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-sonoma", "--log-level", "warn",
    ], { cwd: repoRoot, stdio: "ignore" });
    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i++) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {}
        await delay(100);
    }
    return { proc, endpoint };
}

function hdrMap(headers) {
    if (!headers) return {};
    if (Array.isArray(headers)) {
        const m = {};
        for (const h of headers) m[h.name.toLowerCase()] = h.value;
        return m;
    }
    const m = {};
    for (const [k, v] of Object.entries(headers)) m[k.toLowerCase()] = v;
    return m;
}

async function auditClient(label, connectFn) {
    const docs = [];
    const browser = await connectFn();
    try {
        const page = await browser.newPage();
        const cdp = page.session;
        await cdp.send("Network.enable");

        cdp.on("Network.requestWillBeSent", (p) => {
            if (p.type !== "Document" && p.type !== "document") return;
            const url = p.request?.url || "";
            if (!/google\.com/.test(url)) return;
            docs.push({
                at: Date.now(),
                url: url.slice(0, 200),
                hasSei: url.includes("sei="),
                hasSgSs: url.includes("sg_ss="),
                sorry: url.includes("/sorry"),
                headers: hdrMap(p.request.headers),
            });
        });

        const t0 = Date.now();
        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await delay(2500);
        const probe = await page.evaluate(DEEP_PROBE);
        if (probe.userAgentData?.architecture && typeof probe.userAgentData.architecture?.then === "function") {
            probe.userAgentData.architecture = await probe.userAgentData.architecture;
        }
        if (probe.permissionsQuery?.then) {
            probe.permissionsQuery = await probe.permissionsQuery;
        }
        return {
            label,
            ms: Date.now() - t0,
            probe,
            docFlow: docs,
            docCount: docs.length,
        };
    } finally {
        await browser.close().catch(() => {});
    }
}

async function connectChrome(port) {
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
    const ws = ver.webSocketDebuggerUrl;
    // SDK Browser.connect expects HTTP endpoint; use puppeteer-style ws via fetch targets
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const pageTarget = targets.find((t) => t.type === "page" && !t.url.startsWith("chrome-extension"));
    if (!pageTarget) throw new Error("no chrome page target");
    // Velora SDK won't connect to Chrome WS directly — use chrome-remote-interface style raw eval via spawn
    return null;
}

async function auditChromeIncognito(port) {
    // Use chrome via CDP raw websocket with a minimal client
    const { default: CDP } = await import("chrome-remote-interface").catch(() => ({ default: null }));
    if (!CDP) {
        return { label: "chrome-incognito", error: "chrome-remote-interface not installed" };
    }
    const client = await CDP({ port });
    const { Network, Page, Runtime } = client;
    await Network.enable();
    const docs = [];
    Network.requestWillBeSent((p) => {
        if (p.type !== "Document") return;
        const url = p.request?.url || "";
        if (!/google\.com/.test(url)) return;
        docs.push({
            url: url.slice(0, 200),
            hasSei: url.includes("sei="),
            hasSgSs: url.includes("sg_ss="),
            sorry: url.includes("/sorry"),
        });
    });
    const t0 = Date.now();
    await Page.navigate({ url: SEARCH });
    await Page.loadEventFired();
    await delay(2500);
    const { result } = await Runtime.evaluate({ expression: DEEP_PROBE, returnByValue: true });
    await client.close();
    return {
        label: "chrome-incognito",
        ms: Date.now() - t0,
        probe: result.value,
        docFlow: docs,
        docCount: docs.length,
    };
}

function diffKeys(a, b, prefix = "") {
    const diffs = [];
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
        const pa = a?.[k];
        const pb = b?.[k];
        const path = prefix ? `${prefix}.${k}` : k;
        if (typeof pa === "object" && pa && typeof pb === "object" && pb && !Array.isArray(pa)) {
            diffs.push(...diffKeys(pa, pb, path));
        } else if (JSON.stringify(pa) !== JSON.stringify(pb)) {
            diffs.push({ key: path, velora: pa, chrome: pb });
        }
    }
    return diffs;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    mkdirSync(OUT, { recursive: true });

    console.log("=== Environment audit: Velora vs Chrome (same machine, no proxy) ===\n");

    let veloraProc = null;
    const veloraSpawn = await spawnVelora();
    veloraProc = veloraSpawn.proc;
    const velora = await auditClient("velora", async () => Browser.connect(veloraSpawn.endpoint));

    let chrome = null;
    if (opts.chromePort) {
        try {
            chrome = await auditChromeIncognito(opts.chromePort);
        } catch (e) {
            chrome = { label: "chrome", error: String(e.message || e) };
        }
    } else {
        // Try default Chrome debugging port or launch hint
        for (const port of [9222, 9333]) {
            try {
                const r = await fetch(`http://127.0.0.1:${port}/json/version`);
                if (r.ok) {
                    chrome = await auditChromeIncognito(port);
                    break;
                }
            } catch {}
        }
        if (!chrome) {
            chrome = {
                label: "chrome",
                error: "Start Chrome: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222 --incognito",
            };
        }
    }

    veloraProc.kill("SIGTERM");

    const report = { search: SEARCH, velora, chrome, diffs: null };
    if (velora.probe && chrome?.probe) {
        report.diffs = diffKeys(velora.probe, chrome.probe);
    }

    writeFileSync(resolve(OUT, "report.json"), JSON.stringify(report, null, 2));

    console.log("--- Velora ---");
    console.log(`docs: ${velora.docCount}  sorry: ${velora.probe?.sorry}  sei: ${velora.probe?.hasSei}  sg_ss: ${velora.probe?.hasSgSs}  hits: ${velora.probe?.hits}`);
    for (const d of velora.docFlow) {
        console.log(`  DOC ${d.hasSei ? "sei" : d.hasSgSs ? "sg_ss" : "search"} ${d.url.slice(0, 90)}`);
    }

    console.log("\n--- Chrome ---");
    if (chrome.error) {
        console.log(chrome.error);
    } else {
        console.log(`docs: ${chrome.docCount}  sorry: ${chrome.probe?.sorry}  sei: ${chrome.probe?.hasSei}  sg_ss: ${chrome.probe?.hasSgSs}  hits: ${chrome.probe?.hits}`);
        for (const d of chrome.docFlow) {
            console.log(`  DOC ${d.hasSei ? "sei" : d.hasSgSs ? "sg_ss" : "search"} ${d.url.slice(0, 90)}`);
        }
    }

    if (report.diffs?.length) {
        console.log("\n--- JS env diffs (Velora vs Chrome) ---");
        for (const d of report.diffs.slice(0, 30)) {
            console.log(`  ${d.key}`);
            console.log(`    velora: ${JSON.stringify(d.velora)?.slice(0, 120)}`);
            console.log(`    chrome: ${JSON.stringify(d.chrome)?.slice(0, 120)}`);
        }
        if (report.diffs.length > 30) console.log(`  ... +${report.diffs.length - 30} more`);
    }

    console.log(`\nsaved: ${OUT}/report.json`);
}

main().catch((e) => { console.error(e); process.exit(2); });