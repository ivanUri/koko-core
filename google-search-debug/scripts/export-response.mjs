#!/usr/bin/env node
/**
 * Export Google Search document HTML + hidden fields.
 *
 *   node google-search-debug/scripts/export-response.mjs --engine chrome --query test
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
        chromeSpawn: false,
        chromeEndpoint: process.env.CHROME_CDP || DEFAULT_ENDPOINT,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--engine") out.engine = argv[++i];
        else if (a === "--query") out.query = argv[++i];
        else if (a === "--profile") out.profile = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
        else if (a === "--chrome-spawn") out.chromeSpawn = true;
        else if (a === "--chrome-endpoint") out.chromeEndpoint = argv[++i];
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const url = buildSearchUrl(args.query);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = resolve(OUT_BASE, `export-${args.engine}-${stamp}`);
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

        const capture = await captureGoogleSearch({
            endpoint,
            url,
            label: args.engine,
            maxSec: args.maxSec,
        });

        const { html, ...captureMeta } = capture;
        const meta = {
            at: new Date().toISOString(),
            engine: args.engine,
            query: args.query,
            finalUrl: capture.finalUrl,
            serp: capture.serp,
            dom: capture.dom,
            htmlLen: html?.length || 0,
        };

        await writeFile(resolve(outDir, "meta.json"), JSON.stringify(meta, null, 2));
        await writeFile(resolve(outDir, "response.html"), html || "");
        await writeFile(resolve(outDir, "capture.json"), JSON.stringify(captureMeta, null, 2));

        console.log(`exported ${html?.length || 0} bytes → ${outDir}`);
    } finally {
        killProc(proc);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});