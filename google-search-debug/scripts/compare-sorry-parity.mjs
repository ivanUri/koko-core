#!/usr/bin/env node
/**
 * Sorry / flag-parity compare: Chrome vs Velora on same IP + query.
 * Saves sorry HTML, request graph, document timeline, recaptcha chain diff.
 *
 *   node google-search-debug/scripts/compare-sorry-parity.mjs --query test
 *   npm run google:sorry-parity -- --query test --max-sec 30
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { captureSorryParity } from "../lib/capture-sorry-parity.mjs";
import { diffSorryParity } from "../lib/sorry-parity.mjs";
import {
    REPO,
    buildSearchUrl,
    getFreePort,
    spawnVelora,
    resolveGoogleChromeSession,
    killProc,
} from "../lib/cdp.mjs";

const OUT_BASE = resolve(REPO, "google-search-debug/tmp");

function parseArgs(argv) {
    const out = {
        query: "test",
        profile: "chrome-local-huys-macbook-pro",
        maxSec: 30,
        hl: "en",
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
        else if (a === "--chrome-attach") out.chromeAttach = true;
        else if (a === "--chrome-transport") out.chromeTransport = true;
        else if (a === "--chrome-endpoint") out.chromeEndpoint = argv[++i];
        else if (a === "--output") out.output = resolve(argv[++i]);
    }
    return out;
}

function printSection(title) {
    console.log(`\n=== ${title} ===`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const url = buildSearchUrl(args.query, { hl: args.hl });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = args.output || resolve(OUT_BASE, `sorry-parity-${stamp}`);
    await mkdir(outDir, { recursive: true });

    let chromeProc = null;
    let veloraProc = null;
    let chromeSpawned = false;

    console.log("=== Sorry flag-parity compare ===");
    console.log(`query: ${args.query}`);
    console.log(`url:   ${url}`);
    console.log(`chromeTransport: ${args.chromeTransport}`);
    console.log(`maxSec: ${args.maxSec}`);

    try {
        const chromeSession = await resolveGoogleChromeSession({
            spawn: !args.chromeAttach,
            attachEndpoint: args.chromeEndpoint,
            profileDir: `/tmp/velora-google-debug-chrome-${Date.now()}`,
        });
        chromeProc = chromeSession.proc;
        chromeSpawned = chromeSession.spawned;
        console.log(
            `[chrome] ${chromeSpawned ? "spawned" : "attach"} ${chromeSession.endpoint}`
            + ` ${chromeSession.version?.Browser || ""}`,
        );

        const veloraPort = await getFreePort();
        const veloraLaunch = await spawnVelora(args.profile, veloraPort, {
            googleChromeTransport: args.chromeTransport,
            chromeCdp: args.chromeTransport ? chromeSession.endpoint : null,
        });
        veloraProc = veloraLaunch.proc;
        console.log(
            `[velora] ${veloraLaunch.endpoint}`
            + (args.chromeTransport ? " --google-chrome-transport" : ""),
        );

        const [chrome, velora] = await Promise.all([
            captureSorryParity({ endpoint: chromeSession.endpoint, url, label: "chrome", maxSec: args.maxSec }),
            captureSorryParity({ endpoint: veloraLaunch.endpoint, url, label: "velora", maxSec: args.maxSec }),
        ]);

        const parity = diffSorryParity(chrome, velora);

        await writeFile(resolve(outDir, "chrome-sorry.html"), chrome.html || "");
        await writeFile(resolve(outDir, "velora-sorry.html"), velora.html || "");
        await writeFile(resolve(outDir, "chrome.json"), JSON.stringify({ ...chrome, html: `[${chrome.htmlLen} bytes]` }, null, 2));
        await writeFile(resolve(outDir, "velora.json"), JSON.stringify({ ...velora, html: `[${velora.htmlLen} bytes]` }, null, 2));
        await writeFile(resolve(outDir, "parity.json"), JSON.stringify(parity, null, 2));

        printSection("Summary");
        console.log(`Chrome: ${chrome.network.length} req, recaptcha=${parity.chrome.recaptchaChain.length}, hops=${parity.chrome.documentTimeline.length}`);
        console.log(`Velora: ${velora.network.length} req, recaptcha=${parity.velora.recaptchaChain.length}, hops=${parity.velora.documentTimeline.length}`);
        console.log(`Chrome captcha iframe: ${parity.chrome.dom?.hasRecaptchaIframe}`);
        console.log(`Velora captcha iframe: ${parity.velora.dom?.hasRecaptchaIframe}`);
        console.log(`Chrome grecaptcha: ${JSON.stringify(chrome.grecaptchaProbe)}`);
        console.log(`Velora grecaptcha: ${JSON.stringify(velora.grecaptchaProbe)}`);

        printSection("Document timeline");
        for (const [label, data] of [["Chrome", parity.chrome], ["Velora", parity.velora]]) {
            console.log(`\n${label}:`);
            for (const d of data.documentTimeline) {
                const flags = [
                    d.isSorry ? "sorry" : null,
                    d.isSearch ? "search" : null,
                    d.hasSgSs ? "sg_ss" : null,
                    d.hasSei ? "sei" : null,
                    d.isRecaptcha ? "recaptcha" : null,
                ].filter(Boolean).join(",");
                console.log(`  [${d.i}] ${d.status} ${d.protocol} ${flags}`);
            }
        }

        printSection("Recaptcha chain");
        for (const [label, chain] of [["Chrome", parity.chrome.recaptchaChain], ["Velora", parity.velora.recaptchaChain]]) {
            console.log(`\n${label} (${chain.length}):`);
            for (const r of chain) console.log(`  ${r.status} ${r.protocol} ${r.marker}`);
        }

        printSection(`Parity diff (${parity.summary.length} fields)`);
        for (const row of parity.summary) {
            console.log(`  ${row.field}: chrome=${JSON.stringify(row.chrome)} velora=${JSON.stringify(row.velora)}`);
        }

        if (parity.documentTimelineDiff.length) {
            printSection("Document hop mismatches");
            for (const d of parity.documentTimelineDiff) {
                console.log(`  [${d.i}] chrome=${d.chrome} velora=${d.velora}`);
            }
        }

        if (parity.recaptchaChainDiff.length) {
            printSection("Recaptcha chain mismatches");
            for (const d of parity.recaptchaChainDiff) {
                console.log(`  [${d.i}] chrome=${d.chrome} velora=${d.velora}`);
            }
        }

        if (parity.networkSignatureDiff.length) {
            printSection(`Network signature diff (first ${parity.networkSignatureDiff.length})`);
            for (const d of parity.networkSignatureDiff.slice(0, 15)) {
                console.log(`  [${d.i}]`);
                console.log(`    C: ${d.chrome}`);
                console.log(`    V: ${d.velora}`);
            }
        }

        console.log(`\nSaved: ${outDir}`);
    } finally {
        killProc(veloraProc);
        if (chromeSpawned) killProc(chromeProc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });