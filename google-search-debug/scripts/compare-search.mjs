#!/usr/bin/env node
/**
 * Compare Google Search: real Chrome vs Velora (same query).
 *
 *   node google-search-debug/scripts/compare-search.mjs --query test
 *   node google-search-debug/scripts/compare-search.mjs --query test --chrome-attach  # existing Google Chrome CDP only
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { captureGoogleSearch } from "../lib/capture-search.mjs";
import { diffSessions } from "../lib/parse-serp.mjs";
import {
    REPO,
    buildSearchUrl,
    getFreePort,
    spawnVelora,
    resolveGoogleChromeSession,
    killProc,
} from "../lib/cdp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_BASE = resolve(REPO, "google-search-debug/tmp");

function parseArgs(argv) {
    const out = {
        query: "test",
        profile: "chrome-local-huys-macbook-pro",
        maxSec: 60,
        hl: "en",
        gl: null,
        chromeAttach: false,
        chromeTransport: false,
        chromeEndpoint: process.env.CHROME_CDP || null,
        output: null,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--query") out.query = argv[++i];
        else if (a === "--profile") out.profile = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
        else if (a === "--hl") out.hl = argv[++i];
        else if (a === "--gl") out.gl = argv[++i];
        else if (a === "--chrome-attach") out.chromeAttach = true;
        else if (a === "--chrome-transport") out.chromeTransport = true;
        else if (a === "--chrome-spawn") { /* legacy alias — spawn is already default */ }
        else if (a === "--chrome-endpoint") out.chromeEndpoint = argv[++i];
        else if (a === "--output") out.output = resolve(argv[++i]);
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const url = buildSearchUrl(args.query, { hl: args.hl, gl: args.gl });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = args.output || resolve(OUT_BASE, `compare-${stamp}`);
    await mkdir(outDir, { recursive: true });

    let chromeProc = null;
    let veloraProc = null;
    let chromeSpawned = false;
    let chromeEndpoint = args.chromeEndpoint;

    console.log(`=== Google Search compare ===`);
    console.log(`query: ${args.query}`);
    console.log(`url:   ${url}`);
    console.log(`profile: ${args.profile}`);
    console.log(`chromeTransport: ${args.chromeTransport}`);
    console.log(`maxSec: ${args.maxSec}\n`);

    try {
        const chromeSession = await resolveGoogleChromeSession({
            spawn: !args.chromeAttach,
            attachEndpoint: args.chromeEndpoint,
            profileDir: `/tmp/velora-google-debug-chrome-${Date.now()}`,
        });
        chromeProc = chromeSession.proc;
        chromeEndpoint = chromeSession.endpoint;
        chromeSpawned = chromeSession.spawned;
        console.log(
            `[chrome] ${chromeSpawned ? "spawned" : "attach"} ${chromeEndpoint}`
            + ` bin=${chromeSession.bin}`
            + ` ${chromeSession.version?.Browser || ""}`,
        );

        const veloraPort = await getFreePort();
        const veloraFlags = args.chromeTransport ? " --google-chrome-transport" : "";
        console.log(
            `[velora] serve :${veloraPort} profile=${args.profile}${veloraFlags}`
            + (args.chromeTransport ? ` CHROME_CDP=${chromeEndpoint}` : ""),
        );
        const veloraLaunch = await spawnVelora(args.profile, veloraPort, {
            googleChromeTransport: args.chromeTransport,
            chromeCdp: args.chromeTransport ? chromeEndpoint : null,
        });
        veloraProc = veloraLaunch.proc;

        console.log("[capture] chrome + velora in parallel...");
        const [chrome, velora] = await Promise.all([
            captureGoogleSearch({ endpoint: chromeEndpoint, url, label: "chrome", maxSec: args.maxSec }),
            captureGoogleSearch({ endpoint: veloraLaunch.endpoint, url, label: "velora", maxSec: args.maxSec }),
        ]);

        const diff = diffSessions(chrome, velora);
        const slim = (s) => {
            const { html, ...rest } = s;
            return { ...rest, htmlLen: html?.length || s.htmlLen || 0 };
        };
        const report = {
            at: new Date().toISOString(),
            query: args.query,
            url,
            profile: args.profile,
            chrome: { endpoint: chromeEndpoint, ...slim(chrome) },
            velora: { endpoint: veloraLaunch.endpoint, ...slim(velora) },
            diff,
        };

        await writeFile(resolve(outDir, "chrome.json"), JSON.stringify(slim(chrome), null, 2));
        await writeFile(resolve(outDir, "velora.json"), JSON.stringify(slim(velora), null, 2));
        await writeFile(resolve(outDir, "diff.json"), JSON.stringify(diff, null, 2));
        await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));

        console.log("\n--- SUMMARY ---");
        console.log(`Chrome: ${chrome.serp?.isSorry ? "SORRY" : "OK"}  sg_ss=${chrome.serp?.hasSgSs}  sei=${chrome.serp?.hasSei}`);
        console.log(`        ${chrome.finalUrl?.slice(0, 100)}`);
        console.log(`Velora: ${velora.serp?.isSorry ? "SORRY" : "OK"}  sg_ss=${velora.serp?.hasSgSs}  sei=${velora.serp?.hasSei}`);
        console.log(`        ${velora.finalUrl?.slice(0, 100)}`);
        console.log(`Velora google: sg_b_e=${velora.googleSignals?.sgBeError || "-"} SG_REL=${velora.googleSignals?.hasSgRel}`);
        console.log(`Chrome network=${chrome.networkSummary?.total}  Velora network=${velora.networkSummary?.total}`);
        console.log(`\nDiff fields (${diff.length}):`);
        for (const d of diff) {
            console.log(`  - ${d.field}: chrome=${JSON.stringify(d.chrome)} velora=${JSON.stringify(d.velora)}`);
        }
        console.log(`\nSaved: ${outDir}`);
    } finally {
        killProc(veloraProc);
        if (chromeSpawned) killProc(chromeProc);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});