#!/usr/bin/env node
/**
 * Export cookies from user's Chrome profile → seed Velora jar → Google search.
 *
 *   node google-search-debug/scripts/run-google-search-with-session.mjs --query velora
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";

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

const PROFILE = "chrome-local-huys-macbook-pro";
const COOKIE_JAR = resolve(REPO, `browser/profiles/assets/${PROFILE}-google-cookies.json`);

function parseArgs(argv) {
    const out = {
        query: "velora",
        maxSec: parseMaxSecArg(argv),
        skipExport: false,
        chromeProfile: "Default",
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--query") out.query = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
        else if (a === "--skip-export") out.skipExport = true;
        else if (a === "--chrome-profile") out.chromeProfile = argv[++i];
    }
    return out;
}

function runNode(script, scriptArgs) {
    return new Promise((res, rej) => {
        const proc = spawn("node", [script, ...scriptArgs], { cwd: REPO, stdio: "inherit" });
        proc.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${script} exit ${code}`))));
    });
}

function analyze(html) {
    const pick = (re) => {
        const m = html?.match(re);
        return m ? m[1].trim() : null;
    };
    return {
        bodyLen: html?.length ?? 0,
        sclm: pick(/(?:var|let|const)\s+sclm=([^;]+)/),
        knitsail: (html?.match(/knitsail/g) || []).length,
        title: pick(/<title>([^<]*)<\/title>/),
    };
}

async function searchWithVelora({ query, maxSec }) {
    let proc = null;
    const budget = createProbeBudget(maxSec, ({ signal }) => killProc(proc, signal));
    const port = await getFreePort();
    const launch = await spawnVelora(PROFILE, port, { cookieJar: COOKIE_JAR });
    proc = launch.proc;

    const url = buildSearchUrl(query, { hl: "en" });
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
                const u = new URL(req.url);
                if (u.pathname === "/search" && !u.searchParams.has("sei") && !hop1Cookie) {
                    const headers = Array.isArray(req.headers)
                        ? req.headers
                        : Object.entries(req.headers || {}).map(([name, value]) => ({ name, value }));
                    hop1Cookie = headers.find((h) => h.name.toLowerCase() === "cookie")?.value ?? null;
                }
            }

            if (msg.method === "Network.responseReceived" && p.type === "Document") {
                const r = p.response || {};
                const u = new URL(r.url);
                docs.push({ url: r.url, status: r.status, hasSei: u.searchParams.has("sei") });
                if (u.pathname === "/search" && !u.searchParams.has("sei") && !hop1Body) {
                    await delay(100);
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
        console.log(`[navigate] ${url}`);
        await client.send("Page.navigate", { url }, sessionId).catch(() => {});

        while (budget.remaining() > 400 && !hop1Body) await delay(200);
        while (budget.remaining() > 400 && !docs.some((d) => d.hasSei) && docs.length < 2) {
            await delay(200);
        }

        const metrics = analyze(hop1Body);
        const path = metrics.bodyLen >= 120_000 && metrics.knitsail === 0
            ? "short-direct"
            : docs.some((d) => d.hasSei) ? "long-bootstrap+sei" : "long-bootstrap";

        budget.clear();
        return {
            url,
            cookieJar: COOKIE_JAR,
            cookieSentLen: (hop1Cookie || "").length,
            cookieNames: (hop1Cookie || "").split(";").map((p) => p.trim().split("=")[0]).filter(Boolean),
            metrics,
            path,
            docHops: docs,
        };
    } finally {
        budget.clear();
        client.close();
        killProc(proc);
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    await mkdir(dirname(COOKIE_JAR), { recursive: true });

    console.log("=== Google search with Chrome session cookies ===");
    console.log(`profile: ${PROFILE}`);
    console.log(`jar:     ${COOKIE_JAR}`);
    console.log(`query:   ${args.query}`);

    if (!args.skipExport) {
        console.log("\n[1] Export cookies from your running Chrome account...");
        await runNode(resolve(REPO, "google-search-debug/scripts/export-chrome-live-cookies.mjs"), [
            "--out", COOKIE_JAR,
            "--domain", "google.com",
        ]);
    }

    console.log("\n[2] Velora search with cookie jar...");
    const result = await searchWithVelora({ query: args.query, maxSec: args.maxSec });

    const outDir = resolve(REPO, `google-search-debug/tmp/session-search-${Date.now()}`);
    await mkdir(outDir, { recursive: true });
    await writeFile(resolve(outDir, "report.json"), JSON.stringify(result, null, 2));

    console.log("\n=== Result ===");
    console.log(`path:         ${result.path}`);
    console.log(`hop-1 body:   ${result.metrics.bodyLen} bytes`);
    console.log(`sclm:         ${result.metrics.sclm}`);
    console.log(`knitsail:     ${result.metrics.knitsail}`);
    console.log(`title:        ${result.metrics.title}`);
    console.log(`cookies sent: ${result.cookieSentLen}B (${result.cookieNames.join(", ")})`);
    console.log(`doc hops:     ${result.docHops.length}`);
    for (const d of result.docHops) {
        console.log(`  ${d.status} ${d.url.slice(0, 100)}`);
    }
    console.log(`\njar persisted: ${COOKIE_JAR}`);
    console.log(`report: ${outDir}/report.json`);
}

main().catch((e) => { console.error(e); process.exit(2); });