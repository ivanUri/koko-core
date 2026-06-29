#!/usr/bin/env node
/**
 * Diff hop-1 document REQUEST headers + response sclm: Chrome vs Velora.
 *
 *   node google-search-debug/scripts/diff-hop1-request.mjs --query test
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
    parseMaxSecArg,
} from "../../scripts/lib/cdp-probe-budget.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = {
        profile: "chrome-local-huys-macbook-pro",
        query: "test",
        maxSec: parseMaxSecArg(argv),
        cookieFile: null,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--profile") out.profile = argv[++i];
        else if (a === "--query") out.query = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
        else if (a === "--cookie-file") out.cookieFile = resolve(argv[++i]);
    }
    return out;
}

function isInitialSearch(url) {
    try {
        const u = new URL(url);
        return u.host.includes("google.") && u.pathname === "/search"
            && !u.searchParams.has("sei") && !u.searchParams.has("sg_ss");
    } catch {
        return false;
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

function summarizeRequest(req, res, body) {
    const headers = normalizeHeaders(req?.headers);
    const names = headers.map((h) => h.name.toLowerCase());
    const get = (n) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value ?? null;

    const cookie = get("cookie") || "";
    const cookieNames = cookie
        ? cookie.split(";").map((p) => p.trim().split("=")[0]).filter(Boolean)
        : [];

    const sclm = (() => {
        const m = body?.match(/(?:var|let|const)\s+sclm=([^;]+)/);
        return m ? m[1].trim() : null;
    })();

    return {
        url: req?.url,
        method: req?.method,
        status: res?.status,
        protocol: res?.protocol,
        headerCount: headers.length,
        headerNames: names,
        headers: headers.map((h) => ({ name: h.name, value: h.value.slice(0, 200) })),
        cookieLen: cookie.length,
        cookieNames,
        cookieCount: cookieNames.length,
        userAgent: get("user-agent")?.slice(0, 120),
        accept: get("accept"),
        acceptLanguage: get("accept-language"),
        acceptEncoding: get("accept-encoding"),
        secChUa: get("sec-ch-ua"),
        secChUaMobile: get("sec-ch-ua-mobile"),
        secChUaPlatform: get("sec-ch-ua-platform"),
        secChUaFull: get("sec-ch-ua-full-version-list"),
        secFetchDest: get("sec-fetch-dest"),
        secFetchMode: get("sec-fetch-mode"),
        secFetchSite: get("sec-fetch-site"),
        secFetchUser: get("sec-fetch-user"),
        priority: get("priority"),
        referer: get("referer"),
        upgradeInsecure: get("upgrade-insecure-requests"),
        downlink: get("downlink"),
        rtt: get("rtt"),
        viewportWidth: get("viewport-width"),
        sclm,
        bodyLen: body?.length ?? 0,
    };
}

function diffSummaries(a, b) {
    const keys = [
        "protocol", "headerCount", "cookieLen", "cookieCount", "cookieNames",
        "userAgent", "accept", "acceptLanguage", "acceptEncoding",
        "secChUa", "secChUaMobile", "secChUaPlatform", "secChUaFull",
        "secFetchDest", "secFetchMode", "secFetchSite", "secFetchUser",
        "priority", "referer", "upgradeInsecure", "downlink", "rtt", "viewportWidth",
        "sclm", "bodyLen",
    ];
    const out = [];
    for (const k of keys) {
        const va = a[k];
        const vb = b[k];
        if (JSON.stringify(va) !== JSON.stringify(vb)) {
            out.push({ field: k, velora: va, chrome: vb });
        }
    }

    const orderA = a.headerNames || [];
    const orderB = b.headerNames || [];
    if (orderA.join("|") !== orderB.join("|")) {
        out.push({ field: "headerOrder", velora: orderA, chrome: orderB });
    }

    const onlyVelora = orderA.filter((n) => !orderB.includes(n));
    const onlyChrome = orderB.filter((n) => !orderA.includes(n));
    if (onlyVelora.length || onlyChrome.length) {
        out.push({ field: "headerPresence", onlyVelora, onlyChrome });
    }

    return out;
}

async function captureHop1Request({ endpoint, url, label, budget }) {
    let hopReq = null;
    let hopRes = null;
    let hopBody = null;
    const allDocs = [];

    const conn = await connectCdp(endpoint);
    const { client, sessionId } = conn;

    client.ws.on("message", async (raw) => {
        try {
            const msg = JSON.parse(String(raw));
            if (msg.sessionId && msg.sessionId !== sessionId) return;
            const p = msg.params || {};

            if (msg.method === "Network.requestWillBeSent" && p.type === "Document") {
                allDocs.push({
                    url: p.request?.url,
                    headers: p.request?.headers,
                    method: p.request?.method,
                });
            }

            if (msg.method === "Network.responseReceived" && p.type === "Document") {
                const r = p.response || {};
                if (!isInitialSearch(r.url)) return;
                hopRes = r;
                hopReq = allDocs.find((d) => d.url === r.url) || {
                    url: r.url,
                    method: "GET",
                    headers: r.requestHeaders,
                };
                await delay(80);
                try {
                    const bodyRes = await client.send("Network.getResponseBody", {
                        requestId: p.requestId,
                    }, sessionId);
                    hopBody = bodyRes.base64Encoded
                        ? Buffer.from(bodyRes.body, "base64").toString("utf8")
                        : bodyRes.body;
                } catch {}
            }
        } catch {}
    });

    try {
        await client.send("Network.enable", {}, sessionId);
        await client.send("Page.navigate", { url }, sessionId);

        while (budget.remaining() > 400 && !hopBody) {
            await delay(200);
        }

        const summary = summarizeRequest(hopReq, hopRes, hopBody);
        return { label, summary, allDocUrls: allDocs.map((d) => d.url) };
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
        const launch = await spawnVelora(args.profile, veloraPort, {
            cookieFile: args.cookieFile || undefined,
        });
        veloraProc = launch.proc;

        const chromeSession = await resolveGoogleChromeSession({
            profileDir: `/tmp/velora-hop1-req-chrome-${Date.now()}`,
        });
        chromeProc = chromeSession.proc;

        console.log(`[parallel] ${url}`);
        const [velora, chrome] = await Promise.all([
            captureHop1Request({ endpoint: launch.endpoint, url, label: "velora", budget }),
            captureHop1Request({ endpoint: chromeSession.endpoint, url, label: "chrome", budget }),
        ]);

        const diff = diffSummaries(velora.summary, chrome.summary);
        const report = { url, velora, chrome, diff };

        const outDir = resolve(REPO, `google-search-debug/tmp/hop1-request-diff-${Date.now()}`);
        await mkdir(outDir, { recursive: true });
        await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));

        console.log("\n=== Hop-1 request diff (Velora vs Chrome) ===");
        console.log(`sclm: velora=${velora.summary.sclm} chrome=${chrome.summary.sclm}`);
        console.log(`protocol: velora=${velora.summary.protocol} chrome=${chrome.summary.protocol}`);
        console.log(`cookie: velora=${velora.summary.cookieCount} names (${velora.summary.cookieLen}B) chrome=${chrome.summary.cookieCount} (${chrome.summary.cookieLen}B)`);
        console.log(`sec-fetch-user: velora=${velora.summary.secFetchUser} chrome=${chrome.summary.secFetchUser}`);
        console.log(`\nDiff fields (${diff.length}):`);
        for (const d of diff) {
            if (d.field === "headerOrder") {
                console.log(`- headerOrder: differs (velora ${d.velora.length} vs chrome ${d.chrome.length} headers)`);
                continue;
            }
            if (d.field === "headerPresence") {
                if (d.onlyVelora?.length) console.log(`- only Velora: ${d.onlyVelora.join(", ")}`);
                if (d.onlyChrome?.length) console.log(`- only Chrome: ${d.onlyChrome.join(", ")}`);
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