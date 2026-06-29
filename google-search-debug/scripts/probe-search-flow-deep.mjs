#!/usr/bin/env node
/**
 * Deep Google Search flow trace: document hops, redirects, bootstrap gates, knitsail I/O.
 * Runs Chrome then Velora **sequentially** (30s gap) to reduce IP rate-limit noise.
 *
 *   node google-search-debug/scripts/probe-search-flow-deep.mjs --query deep-test --max-sec 30
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
    enableNetworkBodyCapture,
    attachDocumentBodyCapture,
} from "../lib/cdp.mjs";
import {
    createProbeBudget,
    parseMaxSecArg,
} from "../../scripts/lib/cdp-probe-budget.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const EARLY_HOOK = `(() => {
    const STORE = "__searchFlowDeep";
    const load = () => {
        try { return JSON.parse(sessionStorage.getItem(STORE) || "null"); } catch { return null; }
    };
    const save = (s) => { try { sessionStorage.setItem(STORE, JSON.stringify(s)); } catch {} };
    const hop = (href) => {
        try {
            const u = new URL(href);
            if (!u.host.includes("google.")) return "other";
            if (u.pathname.startsWith("/sorry")) return "sorry";
            if (u.pathname !== "/search") return "other";
            if (u.searchParams.has("sg_ss")) return "sg_ss";
            if (u.searchParams.has("sei")) return "sei";
            return "initial";
        } catch { return "unknown"; }
    };
    const prior = load();
    const state = prior || {
        events: [],
        knitsailCalls: 0,
        replaces: [],
        gateSnaps: [],
    };
    const push = (type, extra = {}) => {
        state.events.push({
            t: performance.now(),
            type,
            hop: hop(location.href),
            href: location.href.slice(0, 200),
            rs: document.readyState,
            pageT: window.chrome?.csi?.()?.pageT ?? null,
            ...extra,
        });
        save(state);
    };
    push("hook-install");
    const origReplace = location.replace.bind(location);
    location.replace = function (u) {
        const s = String(u);
        state.replaces.push({ len: s.length, sg_ss: s.includes("sg_ss="), sei: s.includes("sei="), head: s.slice(0, 160) });
        push("location.replace", { target: s.slice(0, 160) });
        save(state);
        return origReplace(u);
    };
    const wrapKnitsail = () => {
        const k = globalThis.knitsail;
        if (!k || typeof k.a !== "function" || k.a.__wrapped) return false;
        const orig = k.a;
        k.a = function (...args) {
            state.knitsailCalls += 1;
            push("knitsail.a", { call: state.knitsailCalls, arg0len: typeof args[0] === "string" ? args[0].length : null });
            save(state);
            return orig.apply(this, args);
        };
        k.a.__wrapped = true;
        return true;
    };
    wrapKnitsail();
    const obs = new MutationObserver(() => { wrapKnitsail(); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    const poll = setInterval(() => { if (wrapKnitsail()) clearInterval(poll); }, 5);
    setTimeout(() => clearInterval(poll), 15000);
    document.addEventListener("readystatechange", () => {
        let haVal = null;
        try { haVal = typeof ha === "function" ? ha() : null; } catch (e) { haVal = String(e.message); }
        state.gateSnaps.push({
            tag: "rs-" + document.readyState,
            hop: hop(location.href),
            sgs: typeof window.sgs,
            kn: typeof globalThis.knitsail,
            sn: window.google?.sn ?? null,
            td: window.td ? { ...window.td } : null,
            ha: haVal,
            pageT: window.chrome?.csi?.()?.pageT ?? null,
        });
        save(state);
    });
    window.__searchFlowDeep = state;
})();`;

function parseArgs(argv) {
    const out = {
        profile: "chrome-local-huys-macbook-pro",
        query: "test",
        maxSec: parseMaxSecArg(argv),
        gapSec: 30,
        engine: "both",
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--profile") out.profile = argv[++i];
        else if (a === "--query") out.query = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
        else if (a === "--gap-sec") out.gapSec = Number(argv[++i]);
        else if (a === "--engine") out.engine = argv[++i];
    }
    return out;
}

function classifyHop(url) {
    try {
        const u = new URL(url);
        if (!u.host.includes("google.")) return "other";
        if (u.pathname.startsWith("/sorry")) return "sorry";
        if (u.pathname !== "/search") return "other";
        if (u.searchParams.has("sg_ss")) return "sg_ss";
        if (u.searchParams.has("sei")) return "sei";
        return "initial";
    } catch {
        return "unknown";
    }
}

function analyzeHtml(html, hop) {
    const pick = (name) => {
        const hit = html.match(new RegExp(`(?:var|let|const)\\s+${name}=([^;]+)`));
        return hit ? hit[1].trim().slice(0, 60) : null;
    };
    const hasRso = html.includes('id="rso"');
    const hasKnitsail = html.includes("knitsail");
    const inlineCount = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
        .filter((m) => !/src\s*=/i.test(m[1] || "") && (m[2] || "").trim()).length;
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || null;
    return {
        hop,
        htmlLen: html.length,
        title: title?.slice(0, 80) ?? null,
        docKind: hasRso ? "serp" : (hasKnitsail && inlineCount >= 4 ? "bootstrap" : "unknown"),
        inlineScriptCount: inlineCount,
        sclm: pick("sclm"),
        sctm: pick("sctm"),
        ss_cgi: pick("ss_cgi"),
        sp: pick("sp"),
        ussv: pick("ussv"),
        hasKnitsail,
        hasRso,
    };
}

async function traceEngine({ endpoint, url, label, budget }) {
    const timeline = [];
    const bodies = {};
    const rawHtml = {};
    const frameNavs = [];

    const conn = await connectCdp(endpoint);
    const { client, sessionId } = conn;

    const onBody = async (requestId, response, html, err) => {
        const hop = classifyHop(response.url);
        if (!hop || bodies[hop]) return;
        timeline.push({ kind: "body", hop, url: response.url, err: err || null, ts: Date.now() });
        if (err) return;
        bodies[hop] = analyzeHtml(html, hop);
        rawHtml[hop] = html;
    };

    const bodyHandler = attachDocumentBodyCapture(client, sessionId, onBody);

    client.ws.on("message", async (raw) => {
        try {
            const msg = JSON.parse(String(raw));
            if (msg.sessionId && msg.sessionId !== sessionId) return;
            const p = msg.params || {};

            if (msg.method === "Page.frameNavigated") {
                frameNavs.push({
                    url: p.frame?.url,
                    hop: classifyHop(p.frame?.url || ""),
                    ts: Date.now(),
                });
            }

            if (msg.method === "Network.requestWillBeSent") {
                if (p.type === "Document" && p.redirectResponse) {
                    const r = p.redirectResponse;
                    timeline.push({
                        kind: "redirect",
                        from: p.request?.url,
                        status: r.status,
                        location: r.headers?.location || r.headers?.Location || null,
                        ts: Date.now(),
                    });
                }
            }

            if (msg.method === "Network.responseReceived") {
                const r = p.response || {};
                const url = r.url || "";
                if (url.includes("/gen_204") && url.includes("atyp=csi")) {
                    timeline.push({
                        kind: "beacon",
                        url: url.slice(0, 200),
                        ant: (url.match(/[?&]ant=([^&]+)/) || [])[1] ?? null,
                        rt: (url.match(/[?&]rt=([^&]+)/) || [])[1]?.slice(0, 120) ?? null,
                        ts: Date.now(),
                    });
                }
                if (p.type !== "Document") return;
                const hop = classifyHop(r.url);
                timeline.push({
                    kind: "document",
                    hop,
                    url: r.url,
                    status: r.status,
                    protocol: r.protocol,
                    location: r.headers?.location || r.headers?.Location || null,
                    fromDiskCache: r.fromDiskCache ?? false,
                    ts: Date.now(),
                });
            }

            await bodyHandler(raw);
        } catch {}
    });

    try {
        await client.send("Page.addScriptToEvaluateOnNewDocument", { source: EARLY_HOOK }, sessionId);
        await enableNetworkBodyCapture(client, sessionId);
        await client.send("Page.enable", {}, sessionId);
        await client.send("Runtime.enable", {}, sessionId);
        await client.send("Page.navigate", { url }, sessionId);

        const deadline = Date.now() + budget.remaining();
        let stableComplete = 0;
        while (Date.now() < deadline) {
            await delay(400);
            const locRes = await client.send("Runtime.evaluate", {
                expression: `(() => ({ href: location.href, rs: document.readyState, flow: window.__searchFlowDeep || null }))()`,
                returnByValue: true,
            }, sessionId).catch(() => null);
            const loc = locRes?.result?.value;
            if (loc?.href?.includes("/sorry")) break;
            if (bodies.sei?.docKind === "serp" && loc?.rs === "complete") break;
            if (label === "velora" && bodies.sg_ss) break;
            if (bodies.initial && bodies.sei) {
                stableComplete += 1;
                if (stableComplete >= 3) break;
            }
            if (loc?.rs === "complete" && (bodies.sei || bodies.initial)) {
                stableComplete += 1;
                if (stableComplete >= 4) break;
            }
        }

        const flowRes = await client.send("Runtime.evaluate", {
            expression: `(() => window.__searchFlowDeep ? JSON.parse(JSON.stringify(window.__searchFlowDeep)) : null)()`,
            returnByValue: true,
        }, sessionId).catch(() => null);

        return {
            label,
            finalUrl: (await client.send("Runtime.evaluate", {
                expression: `location.href`,
                returnByValue: true,
            }, sessionId).catch(() => null))?.result?.value ?? null,
            timeline,
            frameNavs,
            bodies,
            jsFlow: flowRes?.result?.value ?? null,
            rawHtmlKeys: Object.keys(rawHtml),
            _rawHtml: rawHtml,
        };
    } finally {
        client.close();
    }
}

function summarize(engine) {
    const docs = engine.timeline.filter((e) => e.kind === "document");
    const redirects = engine.timeline.filter((e) => e.kind === "redirect");
    return {
        label: engine.label,
        finalUrl: engine.finalUrl?.slice(0, 160) ?? null,
        documentHops: docs.map((d) => `${d.status} ${d.hop} ${d.protocol} len=${engine.bodies[d.hop]?.htmlLen ?? "?"}`),
        redirectCount: redirects.length,
        redirects: redirects.map((r) => `${r.status} ${r.location?.slice(0, 100)}`),
        bodies: engine.bodies,
        knitsailCalls: engine.jsFlow?.knitsailCalls ?? 0,
        replaceCount: engine.jsFlow?.replaces?.length ?? 0,
        gateSnaps: engine.jsFlow?.gateSnaps ?? [],
        frameNavs: engine.frameNavs?.map((f) => `${f.hop} ${f.url?.slice(0, 100)}`),
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const url = buildSearchUrl(args.query, { hl: "en" });
    const engineMaxSec = args.maxSec;
    const engineCount = args.engine === "both" ? 2 : 1;
    const totalMaxSec = engineMaxSec * engineCount + (args.engine === "both" ? args.gapSec : 0) + 10;
    const budget = createProbeBudget(totalMaxSec);
    const outDir = resolve(REPO, `google-search-debug/tmp/search-flow-deep-${Date.now()}`);
    await mkdir(outDir, { recursive: true });

    let veloraProc = null;
    let chromeProc = null;
    const report = { url, engines: {} };

    try {
        if (args.engine === "both" || args.engine === "chrome") {
            const chromeSession = await resolveGoogleChromeSession({
                profileDir: `/tmp/velora-deep-chrome-${Date.now()}`,
            });
            chromeProc = chromeSession.proc;
            console.log(`[chrome] ${url}`);
            const chromeBudget = createProbeBudget(engineMaxSec);
            const chrome = await traceEngine({
                endpoint: chromeSession.endpoint,
                url,
                label: "chrome",
                budget: chromeBudget,
            });
            chromeBudget.clear();
            for (const [hop, html] of Object.entries(chrome._rawHtml || {})) {
                await writeFile(resolve(outDir, `chrome-${hop}.html`), html);
            }
            delete chrome._rawHtml;
            report.engines.chrome = chrome;
            report.chromeSummary = summarize(chrome);
            killProc(chromeProc);
            chromeProc = null;
            if (args.engine === "both") {
                console.log(`[gap] waiting ${args.gapSec}s before Velora...`);
                await delay(args.gapSec * 1000);
            }
        }

        if (args.engine === "both" || args.engine === "velora") {
            const veloraPort = await getFreePort();
            const launch = await spawnVelora(args.profile, veloraPort);
            veloraProc = launch.proc;
            console.log(`[velora] ${url}`);
            const veloraBudget = createProbeBudget(engineMaxSec);
            const velora = await traceEngine({
                endpoint: launch.endpoint,
                url,
                label: "velora",
                budget: veloraBudget,
            });
            veloraBudget.clear();
            for (const [hop, html] of Object.entries(velora._rawHtml || {})) {
                await writeFile(resolve(outDir, `velora-${hop}.html`), html);
            }
            delete velora._rawHtml;
            report.engines.velora = velora;
            report.veloraSummary = summarize(velora);
        }

        await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));

        console.log("\n=== Chrome summary ===");
        console.log(JSON.stringify(report.chromeSummary, null, 2));
        console.log("\n=== Velora summary ===");
        console.log(JSON.stringify(report.veloraSummary, null, 2));

        if (report.chromeSummary && report.veloraSummary) {
            console.log("\n=== Key divergence ===");
            console.log(`knitsail: chrome=${report.chromeSummary.knitsailCalls} velora=${report.veloraSummary.knitsailCalls}`);
            console.log(`replace: chrome=${report.chromeSummary.replaceCount} velora=${report.veloraSummary.replaceCount}`);
            console.log(`hop1 docKind: chrome=${report.chromeSummary.bodies.initial?.docKind ?? "missing"} velora=${report.veloraSummary.bodies.initial?.docKind ?? "missing"}`);
            console.log(`sei docKind: chrome=${report.chromeSummary.bodies.sei?.docKind ?? "missing"} velora=${report.veloraSummary.bodies.sei?.docKind ?? "missing"}`);
        }
        console.log(`\nsaved: ${outDir}/`);
        budget.clear();
    } finally {
        killProc(veloraProc);
        killProc(chromeProc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });