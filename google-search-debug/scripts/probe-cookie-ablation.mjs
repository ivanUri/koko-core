#!/usr/bin/env node
/**
 * Cookie ablation: which Chrome session cookies flip Google hop-1 to short path?
 *
 *   node google-search-debug/scripts/probe-cookie-ablation.mjs \
 *     --base google-search-debug/tmp/chrome-real-cookies.json
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import {
    REPO,
    buildSearchUrl,
    connectCdp,
    getFreePort,
    spawnVelora,
    killProc,
} from "../lib/cdp.mjs";
import { createProbeBudget, parseMaxSecArg } from "../../scripts/lib/cdp-probe-budget.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = {
        profile: "chrome-local-huys-macbook-pro",
        base: resolve(REPO, "google-search-debug/tmp/chrome-real-cookies.json"),
        maxSec: parseMaxSecArg(argv),
        gapSec: 8,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--profile") out.profile = argv[++i];
        else if (a === "--base") out.base = resolve(argv[++i]);
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
        else if (a === "--gap-sec") out.gapSec = Number(argv[++i]);
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

function analyzeHtml(html) {
    const pick = (re) => {
        const m = html?.match(re);
        return m ? m[1].trim() : null;
    };
    return {
        bodyLen: html?.length ?? 0,
        sclm: pick(/(?:var|let|const)\s+sclm=([^;]+)/),
        ussv: pick(/(?:var|let|const)\s+ussv=([^;]+)/),
        sp: pick(/(?:var|let|const)\s+sp=([^;]+)/),
        knitsail: (html?.match(/knitsail/g) || []).length,
        hasKnitsailA: (html?.match(/knitsail\.a/g) || []).length,
        hasSgSsScript: html?.includes("sg_ss") ?? false,
        hasSeiRedirect: /location\.replace|window\.location\s*=/.test(html || ""),
        tier: null,
    };
}

function classify(metrics, docHops) {
    const hasSeiHop = docHops.some((d) => d.hasSei);
    if (metrics.sclm === "false" || metrics.bodyLen < 120_000) {
        return hasSeiHop ? "long-bootstrap+sei" : "long-bootstrap";
    }
    if (metrics.bodyLen >= 120_000 && metrics.sclm == null && metrics.knitsail === 0) {
        return hasSeiHop ? "short+sei" : "short-direct";
    }
    return "unknown";
}

async function probeCase({ profile, cookies, label, url, maxSec }) {
    const tmpDir = mkdtempSync(resolve(tmpdir(), "velora-cookie-ablation-"));
    const cookieFile = resolve(tmpDir, "cookies.json");
    writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));

    let proc = null;
    const budget = createProbeBudget(maxSec, ({ signal }) => killProc(proc, signal));
    const port = await getFreePort();
    const launch = await spawnVelora(profile, port, { cookieFile });
    proc = launch.proc;

    const docs = [];
    let hop1Body = null;
    let hop1Cookie = null;

    const conn = await connectCdp(launch.endpoint);
    const { client, sessionId } = conn;

    client.ws.on("message", async (raw) => {
        try {
            const msg = JSON.parse(String(raw));
            if (msg.sessionId && msg.sessionId !== sessionId) return;
            const p = msg.params || {};

            if (msg.method === "Network.requestWillBeSent" && p.type === "Document") {
                const req = p.request || {};
                if (isInitialSearch(req.url) && !hop1Cookie) {
                    const headers = Array.isArray(req.headers)
                        ? req.headers
                        : Object.entries(req.headers || {}).map(([name, value]) => ({ name, value }));
                    hop1Cookie = headers.find((h) => h.name.toLowerCase() === "cookie")?.value ?? null;
                }
            }

            if (msg.method === "Network.responseReceived" && p.type === "Document") {
                const r = p.response || {};
                const u = new URL(r.url);
                docs.push({
                    url: r.url,
                    status: r.status,
                    hasSei: u.searchParams.has("sei"),
                    hasSgSs: u.searchParams.has("sg_ss"),
                });
                if (isInitialSearch(r.url) && !hop1Body) {
                    await delay(80);
                    try {
                        const bodyRes = await client.send("Network.getResponseBody", {
                            requestId: p.requestId,
                        }, sessionId);
                        hop1Body = bodyRes.base64Encoded
                            ? Buffer.from(bodyRes.body, "base64").toString("utf8")
                            : bodyRes.body;
                    } catch {}
                }
            }
        } catch {}
    });

    try {
        await client.send("Network.enable", {}, sessionId);
        await client.send("Page.navigate", { url }, sessionId).catch(() => {});
        while (budget.remaining() > 400 && !hop1Body) await delay(200);
        while (budget.remaining() > 400) {
            if (docs.some((d) => d.hasSei) || docs.length >= 2) break;
            await delay(200);
        }

        const metrics = analyzeHtml(hop1Body);
        const tier = classify(metrics, docs);
        budget.clear();
        return {
            label,
            cookieNames: cookies.map((c) => c.name),
            cookieCount: cookies.length,
            cookieLen: (hop1Cookie || "").length,
            metrics,
            tier,
            docHops: docs.length,
            hasSeiHop: docs.some((d) => d.hasSei),
        };
    } finally {
        budget.clear();
        client.close();
        killProc(proc);
    }
}

function buildCases(baseCookies) {
    const byName = Object.fromEntries(baseCookies.map((c) => [c.name, c]));
    const pick = (...names) => names.map((n) => byName[n]).filter(Boolean);

    return [
        { label: "none", cookies: [] },
        { label: "all-5", cookies: baseCookies },
        { label: "NID-only", cookies: pick("NID") },
        { label: "DV-only", cookies: pick("DV") },
        { label: "NID+DV", cookies: pick("NID", "DV") },
        { label: "all-minus-DV", cookies: baseCookies.filter((c) => c.name !== "DV") },
        { label: "all-minus-NID", cookies: baseCookies.filter((c) => c.name !== "NID") },
        { label: "all-minus-AEC", cookies: baseCookies.filter((c) => c.name !== "AEC") },
        { label: "all-minus-BUCKET", cookies: baseCookies.filter((c) => c.name !== "__Secure-BUCKET") },
        { label: "all-minus-STRP", cookies: baseCookies.filter((c) => c.name !== "__Secure-STRP") },
        { label: "guest-4-no-DV", cookies: pick("AEC", "__Secure-BUCKET", "__Secure-STRP", "NID").slice(0, 4) },
    ];
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const baseCookies = JSON.parse(await readFile(args.base, "utf8"));
    const query = `cookie-abl-${Date.now()}`;
    const url = buildSearchUrl(query, { hl: "en" });
    const cases = buildCases(baseCookies);
    const results = [];

    console.log("=== Cookie ablation probe ===");
    console.log(`base: ${args.base}`);
    console.log(`query: ${query}`);
    console.log(`cases: ${cases.length}, gap: ${args.gapSec}s\n`);

    for (let i = 0; i < cases.length; i += 1) {
        const c = cases[i];
        console.log(`[${i + 1}/${cases.length}] ${c.label} (${c.cookies.length} cookies)...`);
        const row = await probeCase({
            profile: args.profile,
            cookies: c.cookies,
            label: c.label,
            url: buildSearchUrl(`${query}-${c.label}`, { hl: "en" }),
            maxSec: args.maxSec,
        });
        results.push(row);
        console.log(`    tier=${row.tier} body=${row.metrics.bodyLen} sclm=${row.metrics.sclm} knitsail=${row.metrics.knitsail} hops=${row.docHops}`);
        if (i < cases.length - 1) await delay(args.gapSec * 1000);
    }

    const outDir = resolve(REPO, `google-search-debug/tmp/cookie-ablation-${Date.now()}`);
    await mkdir(outDir, { recursive: true });
    await writeFile(resolve(outDir, "report.json"), JSON.stringify({ query, url, results }, null, 2));

    console.log("\n=== Summary ===");
    for (const r of results) {
        console.log(`${r.label.padEnd(18)} ${r.tier.padEnd(20)} body=${String(r.metrics.bodyLen).padStart(7)} sclm=${String(r.metrics.sclm).padEnd(6)} cookies=${r.cookieNames.join(",") || "(none)"}`);
    }
    console.log(`\nSaved: ${outDir}/report.json`);
}

main().catch((e) => { console.error(e); process.exit(2); });