#!/usr/bin/env node
/**
 * Diff sei-hop (/search?...&sei=, no sg_ss) document REQUEST + cookies + response doc kind.
 * Also captures hop-1 (initial) for cookie delta context.
 *
 *   node google-search-debug/scripts/diff-sei-request.mjs --query test --max-sec 25
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

function classifySearchHop(url) {
    try {
        const u = new URL(url);
        if (!u.host.includes("google.") || u.pathname !== "/search") return null;
        if (u.searchParams.has("sg_ss")) return "sg_ss";
        if (u.searchParams.has("sei")) return "sei";
        return "initial";
    } catch {
        return null;
    }
}

function normalizeHeaders(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
        return raw.map((h) => ({
            name: h.name || h.key,
            value: String(h.value ?? ""),
        }));
    }
    return Object.entries(raw).map(([name, value]) => ({ name, value: String(value) }));
}

function parseCookieHeader(cookie) {
    if (!cookie) return { names: [], pairs: {}, len: 0 };
    const pairs = {};
    const names = [];
    for (const part of cookie.split(";")) {
        const p = part.trim();
        if (!p) continue;
        const eq = p.indexOf("=");
        const name = eq >= 0 ? p.slice(0, eq) : p;
        const value = eq >= 0 ? p.slice(eq + 1) : "";
        names.push(name);
        pairs[name] = value;
    }
    return { names, pairs, len: cookie.length };
}

function pickGateVar(html, name) {
    const m = html?.match(new RegExp(`(?:var|let|const)\\s+${name}=([^;]+)`));
    return m ? m[1].trim().slice(0, 120) : null;
}

function analyzeBody(html) {
    if (!html) return null;
    const hasRso = html.includes('id="rso"') || html.includes("id='rso'");
    const hasKnitsail = html.includes("knitsail");
    const inlineCount = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
        .filter((x) => !/src\s*=/i.test(x[1] || "") && (x[2] || "").trim()).length;
    return {
        htmlLen: html.length,
        docKind: hasRso ? "serp" : (hasKnitsail && inlineCount >= 4 ? "bootstrap" : "unknown"),
        hasRso,
        hasKnitsail,
        inlineScriptCount: inlineCount,
        sclm: pickGateVar(html, "sclm"),
        sctm: pickGateVar(html, "sctm"),
        ss_cgi: pickGateVar(html, "ss_cgi"),
        sp: pickGateVar(html, "sp"),
        ussv: pickGateVar(html, "ussv"),
    };
}

function summarizeHop(req, res, body, hop) {
    const headers = normalizeHeaders(req?.headers);
    const get = (n) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? null;
    const cookieRaw = get("cookie") || "";
    const cookie = parseCookieHeader(cookieRaw);
    const setCookie = normalizeHeaders(res?.headers)
        .filter((h) => h.name.toLowerCase() === "set-cookie")
        .map((h) => h.value.slice(0, 160));

    return {
        hop,
        url: req?.url || res?.url,
        method: req?.method || "GET",
        status: res?.status,
        protocol: res?.protocol,
        headerNames: headers.map((h) => h.name.toLowerCase()),
        headers: headers.map((h) => ({ name: h.name, value: h.value.slice(0, 240) })),
        cookieLen: cookie.len,
        cookieNames: cookie.names,
        cookiePairs: Object.fromEntries(
            Object.entries(cookie.pairs).map(([k, v]) => [k, v.length > 80 ? `${v.slice(0, 80)}…` : v]),
        ),
        sgSsCookieLen: cookie.pairs.SG_SS?.length ?? cookie.pairs.sg_ss?.length ?? 0,
        userAgent: get("user-agent")?.slice(0, 120),
        referer: get("referer"),
        secFetchSite: get("sec-fetch-site"),
        secFetchMode: get("sec-fetch-mode"),
        secFetchDest: get("sec-fetch-dest"),
        secFetchUser: get("sec-fetch-user"),
        acceptEncoding: get("accept-encoding"),
        cacheControl: get("cache-control"),
        pragma: get("pragma"),
        setCookieCount: setCookie.length,
        setCookie,
        body: analyzeBody(body),
        bodyError: null,
    };
}

function diffHops(a, b, hop) {
    if (!a && !b) return [{ field: hop, note: "both missing" }];
    if (!a) return [{ field: hop, note: "velora missing" }];
    if (!b) return [{ field: hop, note: "chrome missing" }];
    const keys = [
        "protocol", "status", "cookieLen", "cookieNames", "sgSsCookieLen",
        "referer", "secFetchSite", "secFetchMode", "secFetchDest", "secFetchUser",
        "acceptEncoding", "cacheControl", "pragma", "setCookieCount",
    ];
    const out = [];
    for (const k of keys) {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
            out.push({ field: `${hop}.${k}`, velora: a[k], chrome: b[k] });
        }
    }
    const bodyKeys = ["docKind", "htmlLen", "hasKnitsail", "inlineScriptCount", "sclm", "ss_cgi", "sp", "ussv"];
    for (const k of bodyKeys) {
        const va = a.body?.[k];
        const vb = b.body?.[k];
        if (JSON.stringify(va) !== JSON.stringify(vb)) {
            out.push({ field: `${hop}.body.${k}`, velora: va, chrome: vb });
        }
    }
    const onlyV = (a.cookieNames || []).filter((n) => !(b.cookieNames || []).includes(n));
    const onlyC = (b.cookieNames || []).filter((n) => !(a.cookieNames || []).includes(n));
    if (onlyV.length || onlyC.length) {
        out.push({ field: `${hop}.cookieNamesOnly`, onlyVelora: onlyV, onlyChrome: onlyC });
    }
    return out;
}

async function captureSearchHops({ endpoint, url, label, budget }) {
    const requests = new Map();
    const hops = { initial: null, sei: null, sg_ss: null };
    const bodies = { initial: null, sei: null, sg_ss: null };
    const bodyErrors = { initial: null, sei: null, sg_ss: null };
    const docUrls = [];

    const conn = await connectCdp(endpoint);
    const { client, sessionId } = conn;

    const onBody = async (requestId, response, html, err) => {
        const kind = classifySearchHop(response.url);
        if (!kind || hops[kind]) return;
        const req = requests.get(requestId) || { url: response.url, method: "GET", headers: response.requestHeaders };
        if (err) {
            bodyErrors[kind] = err;
            hops[kind] = summarizeHop(req, response, null, kind);
            hops[kind].bodyError = err;
            return;
        }
        bodies[kind] = html;
        hops[kind] = summarizeHop(req, response, html, kind);
    };

    const bodyHandler = attachDocumentBodyCapture(client, sessionId, onBody);

    client.ws.on("message", async (raw) => {
        try {
            const msg = JSON.parse(String(raw));
            if (msg.sessionId && msg.sessionId !== sessionId) return;
            const p = msg.params || {};

            if (msg.method === "Network.requestWillBeSent" && p.type === "Document") {
                requests.set(p.requestId, {
                    url: p.request?.url,
                    method: p.request?.method,
                    headers: p.request?.headers,
                });
                docUrls.push(p.request?.url);
            }

            await bodyHandler(raw);
        } catch {}
    });

    try {
        await enableNetworkBodyCapture(client, sessionId);
        await client.send("Page.navigate", { url }, sessionId);

        while (budget.remaining() > 500) {
            await delay(300);
            if (hops.sei) break;
            if (docUrls.some((u) => u?.includes("/sorry"))) break;
        }

        return {
            label,
            hops,
            bodies: {
                initial: bodies.initial ? analyzeBody(bodies.initial) : null,
                sei: bodies.sei ? analyzeBody(bodies.sei) : null,
            },
            bodyErrors,
            docUrls,
        };
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
            profileDir: `/tmp/velora-sei-req-chrome-${Date.now()}`,
        });
        chromeProc = chromeSession.proc;

        console.log(`[parallel] ${url}`);
        const [velora, chrome] = await Promise.all([
            captureSearchHops({ endpoint: launch.endpoint, url, label: "velora", budget }),
            captureSearchHops({ endpoint: chromeSession.endpoint, url, label: "chrome", budget }),
        ]);

        const diff = [
            ...diffHops(velora.hops.initial, chrome.hops.initial, "initial"),
            ...diffHops(velora.hops.sei, chrome.hops.sei, "sei"),
        ];

        const report = { url, velora, chrome, diff };
        const outDir = resolve(REPO, `google-search-debug/tmp/sei-request-diff-${Date.now()}`);
        await mkdir(outDir, { recursive: true });
        await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));

        console.log("\n=== Hop initial (context) ===");
        for (const side of ["velora", "chrome"]) {
            const h = report[side].hops.initial;
            if (!h) {
                console.log(`${side}: (not captured) err=${report[side].bodyErrors.initial || "—"}`);
                continue;
            }
            console.log(`${side}: ${h.status} ${h.protocol} cookies=${h.cookieNames.length} SG_SS=${h.sgSsCookieLen}B body=${h.body?.docKind} sclm=${h.body?.sclm}`);
        }

        console.log("\n=== Hop sei (target) ===");
        for (const side of ["velora", "chrome"]) {
            const h = report[side].hops.sei;
            if (!h) {
                console.log(`${side}: (not captured) err=${report[side].bodyErrors.sei || "—"}`);
                continue;
            }
            console.log(`${side}: ${h.status} ${h.protocol} cookies=${h.cookieNames.length} SG_SS=${h.sgSsCookieLen}B`);
            console.log(`  referer: ${h.referer || "(none)"}`);
            console.log(`  sec-fetch-site: ${h.secFetchSite} user: ${h.secFetchUser}`);
            console.log(`  body: ${h.body?.docKind} len=${h.body?.htmlLen} knitsail=${h.body?.hasKnitsail} ss_cgi=${h.body?.ss_cgi}`);
            if (h.bodyError) console.log(`  bodyError: ${h.bodyError}`);
        }

        console.log(`\n=== Diff (${diff.length} fields) ===`);
        for (const d of diff) {
            if (d.onlyVelora || d.onlyChrome) {
                if (d.onlyVelora?.length) console.log(`- ${d.field} onlyVelora: ${d.onlyVelora.join(", ")}`);
                if (d.onlyChrome?.length) console.log(`- ${d.field} onlyChrome: ${d.onlyChrome.join(", ")}`);
                continue;
            }
            if (d.note) {
                console.log(`- ${d.field}: ${d.note}`);
                continue;
            }
            console.log(`- ${d.field}: velora=${JSON.stringify(d.velora)} chrome=${JSON.stringify(d.chrome)}`);
        }
        console.log(`\nsaved: ${outDir}/report.json`);
    } finally {
        budget.clear();
        killProc(veloraProc);
        killProc(chromeProc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });