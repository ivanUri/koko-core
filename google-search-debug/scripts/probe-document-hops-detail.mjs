#!/usr/bin/env node
/**
 * Capture all Google Search document hops with response headers + body kind.
 * Detects bootstrap shell vs SERP on sei hop; records Location/redirect signals.
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

function parseArgs(argv) {
    const out = {
        profile: "chrome-local-huys-macbook-pro",
        query: "test",
        maxSec: parseMaxSecArg(argv),
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--profile") out.profile = argv[++i];
        else if (a === "--query") out.query = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
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

function analyzeBody(html, hop) {
    const hasRso = html.includes('id="rso"') || html.includes("id='rso'");
    const hasKnitsail = html.includes("knitsail");
    const inlineCount = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
        .filter((m) => !/src\s*=/i.test(m[1] || "") && (m[2] || "").trim()).length;
    const pick = (name) => {
        const hit = html.match(new RegExp(`(?:var|let|const)\\s+${name}=([^;]+)`));
        return hit ? hit[1].trim().slice(0, 40) : null;
    };
    const title = (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || null;
    return {
        hop,
        htmlLen: html.length,
        title: title?.slice(0, 80) ?? null,
        docKind: hasRso ? "serp" : (hasKnitsail && inlineCount >= 4 ? "bootstrap" : "unknown"),
        hasRso,
        hasKnitsail,
        inlineScriptCount: inlineCount,
        sclm: pick("sclm"),
        ss_cgi: pick("ss_cgi"),
        sp: pick("sp"),
        ussv: pick("ussv"),
    };
}

async function capture({ endpoint, url, label, budget }) {
    const hops = [];
    const bodies = {};
    const conn = await connectCdp(endpoint);
    const { client, sessionId } = conn;

    const onBody = async (requestId, response, html, err) => {
        const hop = classifyHop(response.url);
        const entry = hops.find((h) => h.requestId === requestId);
        if (!entry) return;
        if (!["initial", "sei", "sg_ss", "sorry"].includes(hop) || bodies[hop]) return;
        if (err) {
            entry.bodyError = err;
            return;
        }
        bodies[hop] = html;
        entry.body = analyzeBody(html, hop);
    };

    const bodyHandler = attachDocumentBodyCapture(client, sessionId, onBody);
    client.ws.on("message", async (raw) => {
        try {
            const msg = JSON.parse(String(raw));
            if (msg.sessionId && msg.sessionId !== sessionId) return;
            const p = msg.params || {};

            if (msg.method === "Network.responseReceived" && p.type === "Document") {
                const r = p.response || {};
                const hop = classifyHop(r.url);
                hops.push({
                    requestId: p.requestId,
                    url: r.url,
                    status: r.status,
                    protocol: r.protocol,
                    hop,
                    location: r.headers?.location || r.headers?.Location || null,
                    mimeType: r.mimeType,
                    fromDiskCache: r.fromDiskCache ?? false,
                    fromServiceWorker: r.fromServiceWorker ?? false,
                });
            }

            if (msg.method === "Network.requestWillBeSent" && p.type === "Document") {
                const redirect = p.redirectResponse;
                if (redirect) {
                    hops.push({
                        kind: "redirect",
                        url: p.request?.url,
                        status: redirect.status,
                        location: redirect.headers?.location || redirect.headers?.Location || null,
                    });
                }
            }
            await bodyHandler(raw);
        } catch {}
    });

    try {
        await enableNetworkBodyCapture(client, sessionId);
        await client.send("Page.navigate", { url }, sessionId);

        while (budget.remaining() > 500) {
            await delay(350);
            if (hops.some((h) => h.hop === "sorry")) break;
            if (bodies.initial && bodies.sei) {
                if (label === "velora" && bodies.sg_ss) break;
                if (label === "chrome" && bodies.sei?.includes?.('id="rso"')) break;
            }
        }

        return { label, hops, bodies: Object.fromEntries(
            Object.entries(bodies).map(([k, v]) => [k, analyzeBody(v, k)]),
        ) };
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
    const url = buildSearchUrl(args.query, { hl: "en" });

    try {
        const veloraPort = await getFreePort();
        const launch = await spawnVelora(args.profile, veloraPort);
        veloraProc = launch.proc;

        const chromeSession = await resolveGoogleChromeSession({
            profileDir: `/tmp/velora-doc-hops-chrome-${Date.now()}`,
        });
        chromeProc = chromeSession.proc;

        console.log(`[probe-document-hops] ${url}`);
        const [velora, chrome] = await Promise.all([
            capture({ endpoint: launch.endpoint, url, label: "velora", budget }),
            capture({ endpoint: chromeSession.endpoint, url, label: "chrome", budget }),
        ]);

        const outDir = resolve(REPO, `google-search-debug/tmp/probe-doc-hops-${Date.now()}`);
        await mkdir(outDir, { recursive: true });
        const report = { url, velora, chrome };
        await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));

        for (const [label, data] of [["velora", velora], ["chrome", chrome]]) {
            console.log(`\n=== ${label} ===`);
            for (const h of data.hops.filter((x) => x.hop || x.kind === "redirect")) {
                const loc = h.location ? ` Location=${h.location.slice(0, 80)}` : "";
                const body = h.body ? ` kind=${h.body.docKind} title=${h.body.title}` : (h.bodyError ? ` bodyErr` : "");
                console.log(`  ${h.status ?? ""} ${h.protocol ?? ""} ${h.hop ?? h.kind} ${(h.url || "").slice(0, 90)}${loc}${body}`);
            }
            console.log("  analyzed:", JSON.stringify(data.bodies));
        }
        console.log(`\nsaved: ${outDir}/report.json`);
    } finally {
        budget.clear();
        killProc(veloraProc);
        killProc(chromeProc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });