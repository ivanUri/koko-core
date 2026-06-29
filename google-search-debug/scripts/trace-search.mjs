#!/usr/bin/env node
/**
 * Trace Google Search on one engine (chrome or velora).
 *
 *   node google-search-debug/scripts/trace-search.mjs --engine chrome --query test
 *   node google-search-debug/scripts/trace-search.mjs --engine velora --query test --chrome-spawn
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { captureGoogleSearch } from "../lib/capture-search.mjs";
import {
    REPO,
    buildSearchUrl,
    getFreePort,
    spawnVelora,
    spawnChrome,
    cdpReady,
    normalizeEndpoint,
    DEFAULT_ENDPOINT,
    killProc,
} from "../lib/cdp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_BASE = resolve(REPO, "google-search-debug/tmp");

function parseArgs(argv) {
    const out = {
        engine: "chrome",
        query: "test",
        profile: "chrome-local-huys-macbook-pro",
        maxSec: 60,
        hl: "en",
        chromeSpawn: false,
        chromeEndpoint: process.env.CHROME_CDP || DEFAULT_ENDPOINT,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--engine") out.engine = argv[++i];
        else if (a === "--query") out.query = argv[++i];
        else if (a === "--profile") out.profile = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
        else if (a === "--hl") out.hl = argv[++i];
        else if (a === "--chrome-spawn") out.chromeSpawn = true;
        else if (a === "--chrome-endpoint") out.chromeEndpoint = argv[++i];
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const url = buildSearchUrl(args.query, { hl: args.hl });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = resolve(OUT_BASE, `trace-${args.engine}-${stamp}`);
    await mkdir(outDir, { recursive: true });

    let proc = null;
    let endpoint;

    try {
        if (args.engine === "velora") {
            const port = await getFreePort();
            const launch = await spawnVelora(args.profile, port);
            proc = launch.proc;
            endpoint = launch.endpoint;
        } else {
            endpoint = normalizeEndpoint(args.chromeEndpoint);
            if (args.chromeSpawn || !(await cdpReady(endpoint))) {
                const launched = await spawnChrome({ port: 9335 });
                proc = launched.proc;
                endpoint = launched.endpoint;
            }
        }

        console.log(`[${args.engine}] ${endpoint}`);
        console.log(`url: ${url}`);

        const result = await captureGoogleSearch({
            endpoint,
            url,
            label: args.engine,
            maxSec: args.maxSec,
        });

        const { html, ...meta } = result;
        await writeFile(resolve(outDir, "trace.json"), JSON.stringify(meta, null, 2));
        if (html) await writeFile(resolve(outDir, "response.html"), html);

        console.log("\n--- RESULT ---");
        console.log(`final: ${result.finalUrl}`);
        console.log(`sorry: ${result.serp?.isSorry}`);
        console.log(`sg_ss: ${result.serp?.hasSgSs}`);
        console.log(`network: ${result.networkSummary?.total} requests`);
        console.log(`fp logs: ${result.fpLogs?.length}`);
        const g = result.googleSignals || {};
        console.log(`google: sg_b_e=${g.sgBeError || "-"} SG_REL=${g.hasSgRel} sg_trbl=${g.hasSgTrbl}`);
        console.log(`errors: console=${g.consoleErrorCount} exceptions=${g.exceptionCount}`);
        if (g.firstException) console.log(`first exception: ${g.firstException}`);
        if (result.exceptions?.length) {
            for (const ex of result.exceptions.slice(0, 5)) {
                console.log(`  ex: ${ex.text}${ex.line != null ? ` @${ex.line}` : ""}`);
            }
        }
        console.log(`saved: ${outDir}/trace.json`);
    } finally {
        killProc(proc);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});