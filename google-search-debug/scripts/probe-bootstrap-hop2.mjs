#!/usr/bin/env node
/**
 * Capture SGS bootstrap state on the sei hop (hop 2) before sg_ss redirect.
 * Compare Velora vs Chrome: pageT, ha(), window.td, knitsail.a, location.replace targets.
 */
import { mkdir, writeFile } from "node:fs/promises";
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

const HOOK = `(() => {
    window.__hop2 = {
        replaces: [],
        knitsailCalls: [],
        beacons: [],
        snapshots: [],
    };
    const snap = (tag) => {
        try {
            const p = performance?.timing || {};
            window.__hop2.snapshots.push({
                tag,
                href: location.href,
                rs: document.readyState,
                title: document.title?.slice(0, 80),
                kn: typeof globalThis.knitsail,
                sn: window.google?.sn ?? null,
                sgs: typeof window.sgs,
                pageT: window.chrome?.csi?.()?.pageT ?? null,
                perfNow: performance?.now?.() ?? null,
                td: window.td ? { ...window.td } : null,
                ha: (() => { try { return typeof ha === "function" ? ha() : null; } catch (e) { return "err:" + e.message; } })(),
                timing: {
                    ns: p.navigationStart,
                    rs: p.responseStart,
                    dcl: p.domContentLoadedEventEnd,
                    le: p.loadEventEnd,
                },
            });
        } catch (e) {
            window.__hop2.snapshots.push({ tag, err: String(e) });
        }
    };
    snap("hook");
    const orig = location.replace.bind(location);
    location.replace = function(u) {
        snap("pre-replace");
        window.__hop2.replaces.push(String(u));
        return orig(u);
    };
    const hookK = () => {
        const k = globalThis.knitsail;
        if (!k || k.__h2 || typeof k.a !== "function") return;
        const origA = k.a;
        k.a = function(...args) {
            window.__hop2.knitsailCalls.push({
                pageT: window.chrome?.csi?.()?.pageT ?? null,
                perfNow: performance?.now?.() ?? null,
                argTypes: args.map((a) => (a === null ? "null" : typeof a)),
            });
            snap("knitsail-a");
            return origA.apply(this, args);
        };
        k.__h2 = true;
    };
    const sb = navigator.sendBeacon?.bind(navigator);
    if (sb) {
        navigator.sendBeacon = function(url, data) {
            const u = String(url);
            if (u.includes("gen_204")) {
                window.__hop2.beacons.push({
                    cad: (u.match(/[?&]cad=([^&]+)/) || [])[1] || null,
                    err: (u.match(/[?&]e=([^&]+)/) || [])[1] || null,
                });
            }
            return sb(url, data);
        };
    }
    document.addEventListener("DOMContentLoaded", () => { hookK(); snap("dcl"); });
    const iv = setInterval(() => { hookK(); }, 5);
    setTimeout(() => clearInterval(iv), 15000);
})();`;

const READ = `(() => window.__hop2 || null)()`;

function parseArgs(argv) {
    const out = {
        engines: ["velora", "chrome"],
        profile: "chrome-local-huys-macbook-pro",
        query: "test",
        maxSec: parseMaxSecArg(argv),
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--engine") out.engines = [argv[++i]];
        else if (a === "--profile") out.profile = argv[++i];
        else if (a === "--query") out.query = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
    }
    return out;
}

async function capture({ endpoint, url, label, budget }) {
    const hops = [];
    const conn = await connectCdp(endpoint);
    const { client, sessionId } = conn;

    client.ws.on("message", (raw) => {
        try {
            const m = JSON.parse(String(raw));
            if (m.sessionId && m.sessionId !== sessionId) return;
            const p = m.params || {};
            if (m.method === "Network.requestWillBeSent" && p.type === "Document") {
                hops.push({ url: p.request?.url, ts: Date.now() });
            }
        } catch {}
    });

    try {
        await client.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK }, sessionId);
        await client.send("Network.enable", {}, sessionId);
        await client.send("Page.navigate", { url }, sessionId);

        let hop2 = null;
        while (budget.remaining() > 500) {
            await new Promise((r) => setTimeout(r, 250));
            const ev = await evaluateWithTimeout(client, sessionId, READ, Math.min(3000, budget.remaining()));
            const data = ev.value;
            if (data?.replaces?.length || data?.knitsailCalls?.length) {
                hop2 = data;
                break;
            }
            if (data?.snapshots?.some((s) => s.href?.includes("sei=") && s.sn)) {
                hop2 = data;
                break;
            }
            const lastHop = hops.at(-1)?.url || "";
            if (lastHop.includes("/sorry")) break;
            if (hops.filter((h) => h.url?.includes("/search")).length >= 3) break;
        }
        if (!hop2) {
            const ev = await evaluateWithTimeout(client, sessionId, READ, Math.min(3000, budget.remaining()));
            hop2 = ev.value;
        }
        return { label, url, hops, hop2 };
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
    const results = {};
    const targetUrl = buildSearchUrl(args.query, { hl: "en" });

    try {
        if (args.engines.includes("velora")) {
            const port = await getFreePort();
            const launch = await spawnVelora(args.profile, port);
            veloraProc = launch.proc;
            console.log(`[velora] ${targetUrl}`);
            results.velora = await capture({
                endpoint: launch.endpoint,
                url: targetUrl,
                label: "velora",
                budget,
            });
        }

        if (args.engines.includes("chrome")) {
            const chromeSession = await resolveGoogleChromeSession({
                profileDir: `/tmp/velora-hop2-chrome-${Date.now()}`,
            });
            chromeProc = chromeSession.proc;
            console.log(`[chrome] ${targetUrl}`);
            results.chrome = await capture({
                endpoint: chromeSession.endpoint,
                url: targetUrl,
                label: "chrome",
                budget,
            });
        }

        const outDir = resolve(REPO, `google-search-debug/tmp/probe-hop2-${Date.now()}`);
        await mkdir(outDir, { recursive: true });
        await writeFile(resolve(outDir, "report.json"), JSON.stringify(results, null, 2));

        for (const [eng, r] of Object.entries(results)) {
            const h = r.hop2 || {};
            console.log(`\n=== ${eng} hop2 ===`);
            console.log(`doc hops: ${r.hops?.map((x) => x.url?.split("?")[0] + (x.url?.includes("sei=") ? "+sei" : "") + (x.url?.includes("sg_ss=") ? "+sg_ss" : "")).join(" → ") || "-"}`);
            console.log(`knitsail.a calls: ${h.knitsailCalls?.length ?? 0}`);
            if (h.knitsailCalls?.[0]) console.log(`  pageT at call: ${h.knitsailCalls[0].pageT}`);
            console.log(`location.replace: ${h.replaces?.length ?? 0}`);
            if (h.replaces?.[0]) {
                const u = h.replaces[0];
                console.log(`  target has sg_ss: ${u.includes("sg_ss=")}  len=${u.length}`);
            }
            const last = h.snapshots?.at(-1);
            if (last) {
                console.log(`last snap: tag=${last.tag} sn=${last.sn} pageT=${last.pageT} sgs=${last.sgs}`);
                console.log(`  ha: ${JSON.stringify(last.ha)}`);
            }
            console.log(`beacons: ${(h.beacons || []).map((b) => b.cad + (b.err ? "=" + b.err : "")).join(", ") || "-"}`);
        }
        console.log(`\nsaved: ${outDir}/report.json`);
    } finally {
        budget.clear();
        killProc(veloraProc);
        killProc(chromeProc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });