#!/usr/bin/env node
/**
 * A/B: Velora Google Search with vs without Chrome-exported cookies.
 *
 *   node google-search-debug/scripts/test-velora-chrome-cookies.mjs --query "test-$(date +%s)"
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

import {
    REPO,
    buildSearchUrl,
    connectCdp,
    getFreePort,
    spawnVelora,
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
        query: `cookie-ab-${Date.now()}`,
        maxSec: parseMaxSecArg(argv),
        cookieFile: resolve(REPO, "google-search-debug/tmp/chrome-cookies.json"),
        exportFirst: true,
        chromeAttach: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--profile") out.profile = argv[++i];
        else if (a === "--query") out.query = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
        else if (a === "--cookie-file") out.cookieFile = resolve(argv[++i]);
        else if (a === "--no-export") out.exportFirst = false;
        else if (a === "--chrome-attach") out.chromeAttach = true;
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

function isSeiSearch(url) {
    try {
        const u = new URL(url);
        return u.host.includes("google.") && u.pathname === "/search" && u.searchParams.has("sei");
    } catch {
        return false;
    }
}

function normalizeHeaders(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
        return raw.map((h) => ({ name: h.name || h.key, value: String(h.value ?? "") }));
    }
    return Object.entries(raw).map(([name, value]) => ({ name, value: String(value) }));
}

function headerGet(headers, name) {
    const n = name.toLowerCase();
    return headers.find((h) => h.name.toLowerCase() === n)?.value ?? null;
}

function parseSclm(body) {
    const m = body?.match(/(?:var|let|const)\s+sclm=([^;]+)/);
    return m ? m[1].trim() : null;
}

async function captureSearchFlow(endpoint, url, budget) {
    const docs = [];
    const allDocs = [];
    let hop1Body = null;
    let hop1Cookie = null;
    let hop1Req = null;
    let hop1Res = null;

    const conn = await connectCdp(endpoint);
    const { client, sessionId } = conn;

    client.ws.on("message", async (raw) => {
        try {
            const msg = JSON.parse(String(raw));
            if (msg.sessionId && msg.sessionId !== sessionId) return;
            const p = msg.params || {};

            if (msg.method === "Network.requestWillBeSent" && p.type === "Document") {
                const req = p.request || {};
                allDocs.push(req);
                const headers = normalizeHeaders(req.headers);
                if (isInitialSearch(req.url) && !hop1Cookie) {
                    hop1Cookie = headerGet(headers, "cookie");
                    hop1Req = req;
                }
            }

            if (msg.method === "Network.responseReceived" && p.type === "Document") {
                const r = p.response || {};
                docs.push({
                    url: r.url,
                    status: r.status,
                    protocol: r.protocol,
                    isSorry: r.url.includes("/sorry"),
                    isSearch: r.url.includes("/search"),
                    hasSei: isSeiSearch(r.url),
                    hasSgSs: r.url.includes("sg_ss"),
                });

                if (isInitialSearch(r.url) && !hop1Body) {
                    hop1Res = r;
                    hop1Req = hop1Req || allDocs.find((d) => d.url === r.url) || null;
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

        while (budget.remaining() > 400 && !hop1Body) {
            await delay(200);
        }
        while (budget.remaining() > 400) {
            const hasSorry = docs.some((d) => d.isSorry);
            const hasSei = docs.some((d) => d.hasSei);
            if (hasSorry || hasSei) break;
            await delay(200);
        }

        return {
            documentHops: docs,
            hop1: {
                sclm: parseSclm(hop1Body),
                bodyLen: hop1Body?.length ?? 0,
                status: hop1Res?.status ?? null,
                protocol: hop1Res?.protocol ?? null,
                cookieSent: hop1Cookie,
                cookieLen: (hop1Cookie || "").length,
                cookieNames: (hop1Cookie || "").split(";").map((p) => p.trim().split("=")[0]).filter(Boolean),
            },
            finalKind: docs.at(-1)?.isSorry ? "sorry"
                : docs.some((d) => d.hasSei && d.status === 200) ? "sei-serp"
                : docs.some((d) => d.hasSei) ? "sei"
                : "search-only",
        };
    } finally {
        client.close();
    }
}

async function runVeloraProbe({ profile, cookieFile, url, maxSec, label }) {
    let proc = null;
    const budget = createProbeBudget(maxSec, ({ signal }) => killProc(proc, signal));
    const port = await getFreePort();
    const launch = await spawnVelora(profile, port, { cookieFile: cookieFile || undefined });
    proc = launch.proc;
    try {
        const result = await captureSearchFlow(launch.endpoint, url, budget);
        budget.clear();
        return { label, cookieFile: cookieFile || null, ...result };
    } finally {
        budget.clear();
        killProc(proc);
    }
}

function runExport(cookieFile, chromeAttach) {
    return new Promise((res, rej) => {
        const args = [
            resolve(REPO, "google-search-debug/scripts/export-chrome-cookies.mjs"),
            "--out", cookieFile,
        ];
        if (chromeAttach) args.push("--chrome-attach");
        const proc = spawn("node", args, { cwd: REPO, stdio: "inherit" });
        proc.on("exit", (code) => (code === 0 ? res() : rej(new Error(`export exit ${code}`))));
    });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const url = buildSearchUrl(args.query, { hl: "en" });
    const outDir = resolve(REPO, `google-search-debug/tmp/cookie-ab-${Date.now()}`);
    await mkdir(outDir, { recursive: true });

    console.log("=== Velora cookie A/B ===");
    console.log(`query: ${args.query}`);
    console.log(`url:   ${url}`);

    if (args.exportFirst) {
        console.log("\n[1] Exporting Chrome cookies...");
        await runExport(args.cookieFile, args.chromeAttach);
    }

    console.log("\n[2] Velora WITHOUT cookies...");
    const without = await runVeloraProbe({
        profile: args.profile,
        cookieFile: null,
        url,
        maxSec: args.maxSec,
        label: "no-cookies",
    });

    console.log("    waiting 25s before cookie run...");
    await delay(25_000);

    console.log("\n[3] Velora WITH Chrome cookies...");
    const withCookies = await runVeloraProbe({
        profile: args.profile,
        cookieFile: args.cookieFile,
        url,
        maxSec: args.maxSec,
        label: "with-cookies",
    });

    const report = {
        query: args.query,
        url,
        cookieFile: args.cookieFile,
        without,
        withCookies,
        diff: {
            hop1Sclm: { without: without.hop1.sclm, with: withCookies.hop1.sclm },
            hop1CookieLen: { without: without.hop1.cookieLen, with: withCookies.hop1.cookieLen },
            hop1CookieNames: { without: without.hop1.cookieNames, with: withCookies.hop1.cookieNames },
            finalKind: { without: without.finalKind, with: withCookies.finalKind },
            documentHopCount: { without: without.documentHops.length, with: withCookies.documentHops.length },
        },
    };

    await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));

    console.log("\n=== Results ===");
    console.log(`Hop-1 sclm:  without=${without.hop1.sclm}  with=${withCookies.hop1.sclm}`);
    console.log(`Hop-1 cookie: without=${without.hop1.cookieLen}B (${without.hop1.cookieNames.length} names)`);
    console.log(`              with=${withCookies.hop1.cookieLen}B (${withCookies.hop1.cookieNames.join(", ") || "none"})`);
    console.log(`Final path:  without=${without.finalKind}  with=${withCookies.finalKind}`);
    console.log("\nDocument hops (without):");
    for (const d of without.documentHops) {
        console.log(`  ${d.status} ${d.protocol} ${d.url.slice(0, 100)}`);
    }
    console.log("\nDocument hops (with cookies):");
    for (const d of withCookies.documentHops) {
        console.log(`  ${d.status} ${d.protocol} ${d.url.slice(0, 100)}`);
    }
    console.log(`\nSaved: ${outDir}/report.json`);
}

main().catch((e) => { console.error(e); process.exit(2); });