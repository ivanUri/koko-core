#!/usr/bin/env node
/**
 * List document-hop protocols for Google Search (Chrome vs Velora).
 *
 *   node google-search-debug/scripts/probe-protocol-hops.mjs --chrome-spawn
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { captureGoogleSearch } from "../lib/capture-search.mjs";
import {
    REPO,
    buildSearchUrl,
    getFreePort,
    spawnVelora,
    resolveGoogleChromeSession,
    killProc,
} from "../lib/cdp.mjs";
import { parseMaxSecArg } from "../../scripts/lib/cdp-probe-budget.mjs";

function parseArgs(argv) {
    const out = {
        query: "test",
        profile: "chrome-local-huys-macbook-pro",
        maxSec: parseMaxSecArg(argv),
        chromeAttach: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--query") out.query = argv[++i];
        else if (a === "--profile") out.profile = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
        else if (a === "--chrome-attach") out.chromeAttach = true;
        else if (a === "--no-chrome-spawn") out.chromeAttach = true;
    }
    return out;
}

function documentHops(capture) {
    return (capture.network || [])
        .filter((r) => r.type === "Document")
        .map((r) => ({
            url: (r.url || "").slice(0, 120),
            status: r.status,
            protocol: r.protocol,
            hasSgSs: (r.url || "").includes("sg_ss="),
            hasSei: (r.url || "").includes("sei="),
            isSorry: (r.url || "").includes("/sorry"),
        }));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const url = buildSearchUrl(args.query, { hl: "en" });
    let veloraProc = null;
    let chromeProc = null;

    try {
        const veloraPort = await getFreePort();
        const veloraLaunch = await spawnVelora(args.profile, veloraPort);
        veloraProc = veloraLaunch.proc;

        const chromeSession = await resolveGoogleChromeSession({
            spawn: !args.chromeAttach,
            profileDir: `/tmp/velora-google-debug-chrome-${Date.now()}`,
        });
        chromeProc = chromeSession.proc;
        console.log(
            `[chrome] ${chromeSession.spawned ? "spawned" : "attach"} ${chromeSession.endpoint}`
            + ` ${chromeSession.version?.Browser || ""}`,
        );

        const [velora, chrome] = await Promise.all([
            captureGoogleSearch({ endpoint: veloraLaunch.endpoint, url, label: "velora", maxSec: args.maxSec }),
            captureGoogleSearch({ endpoint: chromeSession.endpoint, url, label: "chrome", maxSec: args.maxSec }),
        ]);

        const report = {
            query: args.query,
            velora: { hops: documentHops(velora), total: velora.networkSummary?.total, finalUrl: velora.finalUrl },
            chrome: chrome ? { hops: documentHops(chrome), total: chrome.networkSummary?.total, finalUrl: chrome.finalUrl } : null,
        };

        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const outDir = resolve(REPO, `google-search-debug/tmp/probe-protocol-${stamp}`);
        await mkdir(outDir, { recursive: true });
        await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));

        console.log("=== Document hops ===\n");
        for (const [label, data] of [["Velora", report.velora], ["Chrome", report.chrome]]) {
            if (!data) continue;
            console.log(`${label} (${data.total} requests):`);
            for (const h of data.hops) {
                const flags = [
                    h.hasSgSs ? "sg_ss" : null,
                    h.hasSei ? "sei" : null,
                    h.isSorry ? "sorry" : null,
                ].filter(Boolean).join(",");
                console.log(`  ${h.status} ${h.protocol} ${flags} ${h.url}`);
            }
            console.log("");
        }
        console.log(`saved: ${outDir}/report.json`);
    } finally {
        killProc(veloraProc);
        killProc(chromeProc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });