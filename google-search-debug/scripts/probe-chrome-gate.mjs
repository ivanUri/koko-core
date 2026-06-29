#!/usr/bin/env node
/**
 * Chrome guest: inject bootstrap hook via CDP + capture hop-1 inline gate vars.
 *
 *   node google-search-debug/scripts/probe-chrome-gate.mjs --query test --max-sec 25
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
    REPO,
    buildSearchUrl,
    connectCdp,
    resolveGoogleChromeSession,
    killProc,
} from "../lib/cdp.mjs";
import {
    createProbeBudget,
    evaluateWithTimeout,
    parseMaxSecArg,
} from "../../scripts/lib/cdp-probe-budget.mjs";

const HOOK = `(() => {
    window.__gateProbe = { snaps: [], replaces: [], knitsailCalls: [] };
    const snap = (tag) => {
        const p = performance?.timing || {};
        let haVal = null;
        try { haVal = typeof ha === "function" ? ha() : null; } catch (e) { haVal = "err:" + e.message; }
        window.__gateProbe.snaps.push({
            tag,
            path: location.pathname
                + (location.search.includes("sei=") ? "+sei" : "")
                + (location.search.includes("sg_ss=") ? "+sg_ss" : ""),
            rs: document.readyState,
            pageT: window.chrome?.csi?.()?.pageT ?? null,
            perfNow: performance.now(),
            sgs: typeof window.sgs,
            kn: typeof globalThis.knitsail,
            sn: window.google?.sn ?? null,
            td: window.td ? Object.assign({}, window.td) : null,
            ha: haVal,
            timing: {
                ns: p.navigationStart,
                rs: p.responseStart,
                dcl: p.domContentLoadedEventEnd,
            },
        });
    };
    snap("hook");
    const origReplace = location.replace.bind(location);
    location.replace = function (u) {
        const s = String(u);
        window.__gateProbe.replaces.push({
            len: s.length,
            sg_ss: s.includes("sg_ss="),
            sei: s.includes("sei="),
            head: s.slice(0, 200),
        });
        snap("replace");
        return origReplace(u);
    };
    const hookK = () => {
        const k = globalThis.knitsail;
        if (!k || k.__gateHook || typeof k.a !== "function") return;
        const origA = k.a;
        k.a = function (...args) {
            window.__gateProbe.knitsailCalls.push({
                pageT: window.chrome?.csi?.()?.pageT ?? null,
                perfNow: performance.now(),
            });
            snap("knitsail-a");
            return origA.apply(this, args);
        };
        k.__gateHook = true;
    };
    document.addEventListener("DOMContentLoaded", () => { hookK(); snap("dcl"); });
    const iv = setInterval(hookK, 5);
    setTimeout(() => clearInterval(iv), 15000);
})();`;

const READ = `(() => {
    const body = document.documentElement?.innerHTML || "";
    const pick = (n) => {
        const m = body.match(new RegExp("(?:var|let|const)\\\\s+" + n + "=([^;]+)"));
        return m ? m[1].trim() : null;
    };
    return {
        href: location.href,
        title: document.title?.slice(0, 120),
        gate: window.__gateProbe || null,
        inline: {
            sclm: pick("sclm"),
            sctm: pick("sctm"),
            ussv: pick("ussv"),
            sp: pick("sp"),
            ss_cgi: pick("ss_cgi"),
        },
    };
})()`;

function parseArgs(argv) {
    const out = { query: "test", maxSec: parseMaxSecArg(argv), hl: "en" };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--query") out.query = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
        else if (a === "--hl") out.hl = argv[++i];
    }
    return out;
}

function parseInlineFromHtml(html) {
    const pick = (n) => {
        const m = html?.match(new RegExp(`(?:var|let|const)\\s+${n}=([^;]+)`));
        return m ? m[1].trim() : null;
    };
    return {
        sclm: pick("sclm"),
        sctm: pick("sctm"),
        ussv: pick("ussv"),
        sp: pick("sp"),
        ss_cgi: pick("ss_cgi"),
        htmlLen: html?.length ?? 0,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const budget = createProbeBudget(args.maxSec, ({ signal }) => killProc(chromeProc, signal));
    let chromeProc = null;
    const url = buildSearchUrl(args.query, { hl: args.hl });
    const hops = [];
    let hop1Html = null;
    let hop1Url = null;

    try {
        const chromeSession = await resolveGoogleChromeSession({
            profileDir: `/tmp/velora-chrome-gate-${Date.now()}`,
        });
        chromeProc = chromeSession.proc;

        const conn = await connectCdp(chromeSession.endpoint);
        const { client, sessionId } = conn;

        client.ws.on("message", async (raw) => {
            try {
                const msg = JSON.parse(String(raw));
                if (msg.sessionId && msg.sessionId !== sessionId) return;
                const p = msg.params || {};
                if (msg.method === "Network.requestWillBeSent" && p.type === "Document") {
                    hops.push({ url: p.request?.url, ts: Date.now() });
                }
                if (msg.method === "Network.responseReceived" && p.type === "Document") {
                    const r = p.response || {};
                    if (r.url?.includes("/search") && !r.url.includes("sei=") && !r.url.includes("sg_ss=")) {
                        hop1Url = r.url;
                        await new Promise((r) => setTimeout(r, 100));
                        try {
                            const bodyRes = await client.send("Network.getResponseBody", {
                                requestId: p.requestId,
                            }, sessionId);
                            hop1Html = bodyRes.base64Encoded
                                ? Buffer.from(bodyRes.body, "base64").toString("utf8")
                                : bodyRes.body;
                        } catch {}
                    }
                }
            } catch {}
        });

        await client.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK }, sessionId);
        await client.send("Network.enable", {}, sessionId);
        await client.send("Page.navigate", { url }, sessionId);

        let live = null;
        while (budget.remaining() > 400) {
            await new Promise((r) => setTimeout(r, 300));
            const ev = await evaluateWithTimeout(client, sessionId, READ, Math.min(2000, budget.remaining()));
            live = ev.value ?? null;
            if (live?.gate?.knitsailCalls?.length || live?.gate?.replaces?.length) break;
            if (live?.href?.includes("/sorry")) break;
            if (hops.length >= 2 && budget.remaining() < 8000) break;
        }

        const report = {
            url,
            hop1Url,
            hop1Inline: parseInlineFromHtml(hop1Html),
            hops: hops.map((h) => h.url),
            live,
        };

        const outDir = resolve(REPO, `google-search-debug/tmp/probe-chrome-gate-${Date.now()}`);
        await mkdir(outDir, { recursive: true });
        await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));
        if (hop1Html) await writeFile(resolve(outDir, "hop1.html"), hop1Html);

        console.log("\n=== Chrome gate probe (CDP inject) ===");
        console.log(`query: ${url}`);
        console.log(`hop-1 inline: ${JSON.stringify(report.hop1Inline)}`);
        console.log(`doc hops: ${report.hops.map((u) => {
            if (!u) return "?";
            if (u.includes("sg_ss=")) return "/search+sg_ss";
            if (u.includes("sei=")) return "/search+sei";
            if (u.includes("/sorry")) return "/sorry";
            return "/search";
        }).join(" → ")}`);
        const g = live?.gate;
        if (g) {
            console.log(`knitsail.a calls: ${g.knitsailCalls?.length ?? 0}`);
            if (g.knitsailCalls?.[0]) console.log(`  pageT at knitsail.a: ${g.knitsailCalls[0].pageT}`);
            console.log(`location.replace: ${g.replaces?.length ?? 0}`);
            for (const r of g.replaces || []) {
                console.log(`  replace sg_ss=${r.sg_ss} len=${r.len} head=${r.head?.slice(0, 80)}`);
            }
            const dcl = g.snaps?.find((s) => s.tag === "dcl");
            if (dcl) console.log(`dcl snap: pageT=${dcl.pageT} kn=${dcl.kn} sgs=${dcl.sgs} sn=${dcl.sn} ha=${JSON.stringify(dcl.ha)}`);
        } else {
            console.log("(no live gate data — page may have navigated away before evaluate)");
        }
        console.log(`\nsaved: ${outDir}/report.json`);
        client.close();
    } finally {
        budget.clear();
        killProc(chromeProc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });