#!/usr/bin/env node
/**
 * Probe Google Search bootstrap APIs on Velora or Chrome.
 *
 *   node google-search-debug/scripts/probe-google-js.mjs --engine velora
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
    const out = {};
    const has = (k, v) => { out[k] = v; };
    has("userAgent", navigator.userAgent?.slice(0, 80));
    has("webdriver", navigator.webdriver);
    has("sendBeacon", typeof navigator.sendBeacon);
    has("trustedTypes", typeof trustedTypes);
    has("ttCreatePolicy", typeof trustedTypes?.createPolicy);
    has("sessionStorage", typeof sessionStorage);
    has("performance", typeof performance);
    has("perfNavEntries", typeof performance?.getEntriesByType === "function"
        ? performance.getEntriesByType("navigation").length : null);
    has("perfTiming", !!performance?.timing);
    has("Promise", typeof Promise);
    has("SymbolIterator", typeof Symbol?.iterator);
    has("evalWorks", (() => { try { return eval("1+1") === 2; } catch (e) { return String(e); } })());
    has("ttEval", (() => {
        try {
            if (!trustedTypes?.createPolicy) return "no-policy";
            const p = trustedTypes.createPolicy("x", { createScript: (s) => s });
            return p.createScript("1+1").toString();
        } catch (e) { return "err:" + e; }
    })());
    has("cookieLen", document.cookie?.length ?? 0);
    has("googleSn", window.google?.sn ?? null);
    has("googleKEI", window.google?.kEI ?? null);
    has("prs", typeof window.prs);
    has("pr", typeof window.pr);
    has("sgs", typeof window.sgs);
    has("onerror", typeof window.onerror);
    has("readyState", document.readyState);
    has("title", document.title);
    return out;
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
    let endpoint;

    try {
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
            await delay(8000);
            const res = await client.send("Runtime.evaluate", {
                expression: PROBE,
                returnByValue: true,
                awaitPromise: false,
            }, sessionId);
            const probe = res.result?.value || { error: res.exceptionDetails?.text };
            const outDir = resolve(REPO, "google-search-debug/tmp");
            await mkdir(outDir, { recursive: true });
            const path = resolve(outDir, `probe-${args.engine}.json`);
            await writeFile(path, JSON.stringify({ engine: args.engine, url, probe }, null, 2));
            console.log(JSON.stringify(probe, null, 2));
            console.log(`\nSaved: ${path}`);
        } finally {
            client.close();
        }
    } finally {
        killProc(proc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });