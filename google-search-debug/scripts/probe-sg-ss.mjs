#!/usr/bin/env node
/**
 * Probe SGS bootstrap: window.td, ha(), knitsail.a(), sg_ss redirect, gen_204 beacons.
 *
 *   node google-search-debug/scripts/probe-sg-ss.mjs              # local fixture
 *   node google-search-debug/scripts/probe-sg-ss.mjs --live       # live Google
 *   node google-search-debug/scripts/probe-sg-ss.mjs --live --chrome-spawn  # + Chrome baseline
 */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
    REPO,
    buildSearchUrl,
    connectCdp,
    getFreePort,
    spawnVelora,
    resolveGoogleChromeSession,
    killProc,
} from "../lib/cdp.mjs";
import {
    createProbeBudget,
    evaluateWithTimeout,
    parseMaxSecArg,
} from "../../scripts/lib/cdp-probe-budget.mjs";

const HOOK_SOURCE = `(() => {
    window.__sgProbe = {
        ha: null,
        td: null,
        knitsailCalls: [],
        locations: [],
        beacons: [],
        errors: [],
    };
    const pushLoc = () => {
        try { window.__sgProbe.locations.push(location.href); } catch (e) {}
    };
    pushLoc();
    const origReplace = location.replace.bind(location);
    location.replace = function(u) {
        window.__sgProbe.locations.push(String(u));
        return origReplace(u);
    };
    const wrapBeacon = () => {
        const sb = navigator.sendBeacon?.bind(navigator);
        if (!sb) return;
        navigator.sendBeacon = function(url, data) {
            const u = String(url);
            if (u.includes("gen_204")) {
                window.__sgProbe.beacons.push({
                    url: u,
                    cad: (u.match(/[?&]cad=([^&]+)/) || [])[1] || null,
                    err: (u.match(/[?&]e=([^&]+)/) || [])[1] || null,
                });
            }
            return sb(url, data);
        };
    };
    wrapBeacon();
    const pollTd = () => {
        try {
            if (window.td) window.__sgProbe.td = { ...window.td };
        } catch (e) {}
    };
    const pollHa = () => {
        try {
            if (typeof ha === "function") window.__sgProbe.ha = ha();
        } catch (e) {
            window.__sgProbe.errors.push("ha:" + e.message);
        }
    };
    const hookKnitsail = () => {
        const k = globalThis.knitsail;
        if (!k || k.__sgHooked || typeof k.a !== "function") return false;
        const orig = k.a;
        k.a = function(...args) {
            window.__sgProbe.knitsailCalls.push({
                argTypes: args.map((a) => (a === null ? "null" : typeof a)),
                arg0Keys: args[0] && typeof args[0] === "object" ? Object.keys(args[0]).slice(0, 12) : null,
            });
            return orig.apply(this, args);
        };
        k.__sgHooked = true;
        return true;
    };
    const iv = setInterval(() => {
        pollTd();
        hookKnitsail();
        if (document.readyState !== "loading") {
            pollHa();
            clearInterval(iv);
        }
    }, 5);
    document.addEventListener("DOMContentLoaded", () => {
        pollTd();
        pollHa();
        hookKnitsail();
    });
})();`;

const READ_PROBE = `(() => {
    const p = window.__sgProbe || {};
    const href = location.href;
    const sg = (() => {
        try {
            const u = new URL(href);
            const v = u.searchParams.get("sg_ss");
            return v ? { len: v.length, prefix: v.slice(0, 32), hasStar: v.startsWith("*") } : null;
        } catch { return null; }
    })();
    return {
        href,
        title: document.title,
        readyState: document.readyState,
        kn: typeof globalThis.knitsail,
        sn: window.google?.sn ?? null,
        sg_ss: sg,
        probe: p,
        perf: {
            ns: performance?.timing?.navigationStart ?? null,
            rs: performance?.timing?.responseStart ?? null,
            pageT: window.chrome?.csi?.()?.pageT ?? null,
        },
    };
})()`;

function parseArgs(argv) {
    const out = {
        live: false,
        chrome: false,
        profile: "chrome-local-huys-macbook-pro",
        query: "test",
        maxSec: parseMaxSecArg(argv),
        out: null,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--live") out.live = true;
        else if (a === "--chrome-spawn") out.chrome = true;
        else if (a === "--profile") out.profile = argv[++i];
        else if (a === "--query") out.query = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
        else if (a === "--output") out.out = resolve(argv[++i]);
    }
    return out;
}

async function captureSession({ endpoint, url, label, budget, live = false }) {
    const requests = [];
    const responses = new Map();
    const conn = await connectCdp(endpoint);
    const { client, sessionId } = conn;

    client.ws.on("message", (raw) => {
        try {
            const m = JSON.parse(String(raw));
            if (m.sessionId && m.sessionId !== sessionId) return;
            const p = m.params || {};
            if (m.method === "Network.requestWillBeSent") {
                requests.push({
                    id: p.requestId,
                    url: p.request?.url,
                    type: p.type,
                    method: p.request?.method,
                });
            }
            if (m.method === "Network.responseReceived") {
                responses.set(p.requestId, {
                    status: p.response?.status,
                    protocol: p.response?.protocol,
                    url: p.response?.url,
                });
            }
        } catch {}
    });

    try {
        await client.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK_SOURCE }, sessionId);
        await client.send("Network.enable", {}, sessionId);
        await client.send("Runtime.enable", {}, sessionId);
        await client.send("Page.navigate", { url }, sessionId);

        let snapshot = null;
        while (budget.remaining() > 500) {
            await new Promise((r) => setTimeout(r, 400));
            const ev = await evaluateWithTimeout(client, sessionId, READ_PROBE, Math.min(5000, budget.remaining()));
            if (ev.value) snapshot = ev.value;
            const href = snapshot?.href || "";
            if (budget.remaining() < 2000) break;
            if (href.includes("sg_ss=") || href.includes("/sorry") || snapshot?.probe?.beacons?.some((b) => b.cad === "sg_b_e")) break;
            if (!live && snapshot?.readyState === "complete") break;
            if (live && snapshot?.readyState === "complete" && (href.includes("/sorry") || href.includes("google.com/search"))) break;
        }

        for (const req of requests) {
            const res = responses.get(req.id);
            if (res) Object.assign(req, res);
        }

        return { label, url, snapshot, requests };
    } finally {
        client.close();
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const budget = createProbeBudget(args.maxSec, ({ signal }) => {
        killProc(veloraProc, signal);
        killProc(chromeProc, signal);
    });

    let veloraProc = null;
    let chromeProc = null;
    let httpServer = null;
    const results = {};

    try {
        const veloraPort = await getFreePort();
        const launch = await spawnVelora(args.profile, veloraPort);
        veloraProc = launch.proc;

        let targetUrl;
        if (args.live) {
            targetUrl = buildSearchUrl(args.query, { hl: "en" });
        } else {
            const htmlPath = resolve(
                REPO,
                "google-search-debug/tmp/trace-velora-2026-06-28T18-19-39-463Z/response.html",
            );
            const httpPort = await getFreePort();
            const html = await readFile(htmlPath, "utf8");
            httpServer = createServer((req, res) => {
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(html);
            });
            await new Promise((r) => httpServer.listen(httpPort, "127.0.0.1", r));
            targetUrl = `http://127.0.0.1:${httpPort}/`;
        }

        console.log(`[velora] ${targetUrl}`);
        results.velora = await captureSession({
            endpoint: launch.endpoint,
            url: targetUrl,
            label: "velora",
            budget,
            live: args.live,
        });

        if (args.chrome && args.live) {
            const chromeSession = await resolveGoogleChromeSession({
                profileDir: `/tmp/velora-google-debug-chrome-${Date.now()}`,
            });
            chromeProc = chromeSession.proc;
            console.log(
                `[chrome] spawned ${chromeSession.endpoint} ${chromeSession.version?.Browser || ""}`,
            );
            console.log(`[chrome] ${targetUrl}`);
            results.chrome = await captureSession({
                endpoint: chromeSession.endpoint,
                url: targetUrl,
                label: "chrome",
                budget,
                live: true,
            });
        }

        const outDir = args.out || resolve(REPO, `google-search-debug/tmp/probe-sg-ss-${Date.now()}`);
        await mkdir(outDir, { recursive: true });
        await writeFile(resolve(outDir, "report.json"), JSON.stringify(results, null, 2));

        const v = results.velora?.snapshot;
        console.log("\n=== Velora SGS probe ===");
        console.log(`knitsail: ${v?.kn}`);
        console.log(`knitsail.a calls: ${v?.probe?.knitsailCalls?.length ?? 0}`);
        console.log(`ha(): ${JSON.stringify(v?.probe?.ha)}`);
        console.log(`window.td: ${JSON.stringify(v?.probe?.td)}`);
        console.log(`perf.pageT: ${v?.perf?.pageT}`);
        console.log(`sg_ss: ${v?.sg_ss ? `len=${v.sg_ss.len} prefix=${v.sg_ss.prefix}` : "none"}`);
        console.log(`beacons: ${(v?.probe?.beacons || []).map((b) => b.cad || b.url).join(", ") || "-"}`);
        console.log(`locations: ${(v?.probe?.locations || []).length}`);
        console.log(`network: ${results.velora?.requests?.length}`);
        console.log(`saved: ${outDir}/report.json`);

        if (results.chrome) {
            const c = results.chrome?.snapshot;
            console.log("\n=== Chrome SGS probe ===");
            console.log(`knitsail.a calls: ${c?.probe?.knitsailCalls?.length ?? 0}`);
            console.log(`ha(): ${JSON.stringify(c?.probe?.ha)}`);
            console.log(`sg_ss: ${c?.sg_ss ? `len=${c.sg_ss.len}` : "none"}`);
            console.log(`beacons: ${(c?.probe?.beacons || []).map((b) => b.cad).join(", ") || "-"}`);
            console.log(`network: ${results.chrome?.requests?.length}`);
        }
    } finally {
        budget.clear();
        killProc(veloraProc);
        killProc(chromeProc);
        httpServer?.close();
    }
}

main().catch((e) => { console.error(e); process.exit(2); });