#!/usr/bin/env node
/**
 * Capture Chrome document /search hop headers via --log-net-log (wire truth, not CDP).
 * Compares with Velora VELORA_WIRE_HEADERS for initial + sei hops.
 *
 *   node google-search-debug/scripts/capture-chrome-wire-hops.mjs --query test --max-sec 25
 */
import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

import {
    REPO,
    buildSearchUrl,
    connectCdp,
    getFreePort,
    spawnVelora,
    CHROME_BIN,
    assertGoogleChromeBin,
    killProc,
} from "../lib/cdp.mjs";
import { createProbeBudget, parseMaxSecArg } from "../../scripts/lib/cdp-probe-budget.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = {
        profile: "chrome-local-huys-macbook-pro",
        query: "test",
        maxSec: parseMaxSecArg(argv),
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--profile") out.profile = argv[++i];
        else if (a === "--query") out.query = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
    }
    return out;
}

function classifyHop(url) {
    try {
        const u = new URL(url);
        if (!u.host.includes("google.") || u.pathname !== "/search") return null;
        if (u.searchParams.has("sg_ss")) return "sg_ss";
        if (u.searchParams.has("sei")) return "sei";
        return "initial";
    } catch {
        return null;
    }
}

function parseNetLogHeaders(extra) {
    const out = {};
    if (!extra || !Array.isArray(extra.headers)) return out;
    for (const h of extra.headers) {
        if (h?.name) out[String(h.name).toLowerCase()] = String(h.value ?? "");
    }
    return out;
}

function extractSearchHops(netlog) {
    const hops = {};
    const events = netlog?.events || [];
    for (const ev of events) {
        if (ev.type !== "URL_REQUEST") continue;
        const url = ev.params?.url || "";
        const hop = classifyHop(url);
        if (!hop || hops[hop]) continue;
        const headers = parseNetLogHeaders(ev.params?.extra_request_headers);
        hops[hop] = {
            hop,
            url,
            headers,
            secFetchSite: headers["sec-fetch-site"] ?? null,
            secFetchMode: headers["sec-fetch-mode"] ?? null,
            secFetchDest: headers["sec-fetch-dest"] ?? null,
            secFetchUser: headers["sec-fetch-user"] ?? null,
            referer: headers.referer ?? null,
            downlink: headers.downlink ?? null,
            rtt: headers.rtt ?? null,
        };
    }
    return hops;
}

async function readWireHops(wireFile) {
    const raw = await readFile(wireFile, "utf8");
    const hops = {};
    for (const line of raw.trim().split("\n").filter(Boolean)) {
        const entry = JSON.parse(line);
        const hop = entry.hop || classifyHop(entry.url);
        if (!hop) continue;
        const map = {};
        for (const h of entry.headers || []) {
            map[String(h.name).toLowerCase()] = String(h.value ?? "");
        }
        hops[hop] = {
            hop,
            url: entry.url,
            secFetchSite: map["sec-fetch-site"] ?? null,
            secFetchMode: map["sec-fetch-mode"] ?? null,
            secFetchDest: map["sec-fetch-dest"] ?? null,
            secFetchUser: map["sec-fetch-user"] ?? null,
            referer: map.referer ?? null,
            downlink: map.downlink ?? null,
            rtt: map.rtt ?? null,
        };
    }
    return hops;
}

async function spawnChromeNetLog(profileDir, netlogPath, port) {
    assertGoogleChromeBin();
    const proc = spawn(
        CHROME_BIN,
        [
            `--remote-debugging-port=${port}`,
            `--user-data-dir=${profileDir}`,
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-sync",
            "--guest",
            `--log-net-log=${netlogPath}`,
            "about:blank",
        ],
        { stdio: "ignore" },
    );
    const endpoint = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        try {
            if ((await fetch(`${endpoint}/json/version`)).ok) return { proc, endpoint };
        } catch {}
        await delay(200);
    }
    throw new Error("Chrome net-log spawn timeout");
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const url = buildSearchUrl(args.query, { hl: "en" });
    const outDir = resolve(REPO, `google-search-debug/tmp/chrome-wire-hops-${Date.now()}`);
    await mkdir(outDir, { recursive: true });
    const netlogPath = resolve(outDir, "chrome-netlog.json");
    const wireFile = resolve(outDir, "velora-wire.jsonl");

    const budget = createProbeBudget(args.maxSec);
    let veloraProc = null;
    let chromeProc = null;

    try {
        const chromePort = await getFreePort();
        const chromeProfile = `/tmp/velora-chrome-wire-${Date.now()}`;
        const chromeLaunch = await spawnChromeNetLog(chromeProfile, netlogPath, chromePort);
        chromeProc = chromeLaunch.proc;

        const veloraPort = await getFreePort();
        const veloraLaunch = await spawnVelora(args.profile, veloraPort, {
            env: { VELORA_WIRE_HEADERS: "1", VELORA_WIRE_HEADERS_FILE: wireFile },
        });
        veloraProc = veloraLaunch.proc;

        const navigate = async (endpoint) => {
            const conn = await connectCdp(endpoint);
            const { client, sessionId } = conn;
            try {
                await client.send("Page.navigate", { url }, sessionId);
                while (budget.remaining() > 500) {
                    await delay(300);
                    if (existsSync(netlogPath) && existsSync(wireFile)) break;
                }
            } finally {
                client.close();
            }
        };

        await Promise.all([navigate(chromeLaunch.endpoint), navigate(veloraLaunch.endpoint)]);
        await delay(1500);

        let chromeHops = {};
        if (existsSync(netlogPath)) {
            const netlog = JSON.parse(await readFile(netlogPath, "utf8"));
            chromeHops = extractSearchHops(netlog);
        }
        const veloraHops = existsSync(wireFile) ? await readWireHops(wireFile) : {};

        const report = { url, chromeHops, veloraHops };
        await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));

        console.log("=== Chrome net-log /search hops ===");
        for (const hop of ["initial", "sei", "sg_ss"]) {
            const c = chromeHops[hop];
            if (!c) continue;
            console.log(`[chrome ${hop}] sec-fetch-site=${c.secFetchSite} mode=${c.secFetchMode} dest=${c.secFetchDest} user=${c.secFetchUser}`);
        }
        console.log("\n=== Velora wire /search hops ===");
        for (const hop of ["initial", "sei", "sg_ss"]) {
            const v = veloraHops[hop];
            if (!v) continue;
            console.log(`[velora ${hop}] sec-fetch-site=${v.secFetchSite} mode=${v.secFetchMode} dest=${v.secFetchDest} user=${v.secFetchUser}`);
        }
        console.log(`\nsaved: ${outDir}/report.json`);
    } finally {
        killProc(veloraProc);
        killProc(chromeProc);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});