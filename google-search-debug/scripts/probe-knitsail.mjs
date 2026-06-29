#!/usr/bin/env node
/**
 * Probe knitsail bootstrap state after Google Search navigation.
 */
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    REPO,
    buildSearchUrl,
    connectCdp,
    getFreePort,
    spawnVelora,
    spawnChrome,
    cdpReady,
    normalizeEndpoint,
    DEFAULT_ENDPOINT,
    killProc,
} from "../lib/cdp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const PROBE = `(() => {
    const k = globalThis.knitsail;
    return {
        hasKnitsail: k != null,
        knitsailKeys: k ? Object.keys(k) : [],
        hasKnitsailA: typeof k?.a === "function",
        googleSn: window.google?.sn ?? null,
        googleKEI: window.google?.kEI ?? null,
        scriptCount: document.scripts?.length ?? 0,
        inlineScripts: [...document.scripts].filter(s => !s.src).length,
        title: document.title,
        readyState: document.readyState,
    };
})()`;

function parseArgs(argv) {
    const out = { engine: "velora", query: "test", profile: "chrome-local-huys-macbook-pro", chromeSpawn: false };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--engine") out.engine = argv[++i];
        else if (a === "--query") out.query = argv[++i];
        else if (a === "--profile") out.profile = argv[++i];
        else if (a === "--chrome-spawn") out.chromeSpawn = true;
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const url = buildSearchUrl(args.query);
    let proc = null;

    try {
        let endpoint;
        if (args.engine === "velora") {
            const port = await getFreePort();
            const launch = await spawnVelora(args.profile, port);
            proc = launch.proc;
            endpoint = launch.endpoint;
        } else {
            endpoint = normalizeEndpoint(DEFAULT_ENDPOINT);
            if (args.chromeSpawn || !(await cdpReady(endpoint))) {
                const launched = await spawnChrome({ port: 9335 });
                proc = launched.proc;
                endpoint = launched.endpoint;
            }
        }

        const { client, sessionId } = await connectCdp(endpoint);
        try {
            await client.send("Runtime.enable", {}, sessionId);
            await client.send("Page.navigate", { url }, sessionId);
            for (const wait of [3000, 8000, 15000]) {
                await delay(wait);
                const res = await client.send("Runtime.evaluate", {
                    expression: PROBE,
                    returnByValue: true,
                }, sessionId);
                const probe = res.result?.value;
                console.log(`\n@${wait}ms:`, JSON.stringify(probe, null, 2));
            }
            const outDir = resolve(REPO, "google-search-debug/tmp");
            await mkdir(outDir, { recursive: true });
            await writeFile(resolve(outDir, `knitsail-${args.engine}.json`), "{}");
        } finally {
            client.close();
        }
    } finally {
        killProc(proc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });