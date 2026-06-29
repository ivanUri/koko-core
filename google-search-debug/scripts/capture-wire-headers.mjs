#!/usr/bin/env node
/**
 * Capture Velora hop-1 wire headers via curl CURLOPT_DEBUGFUNCTION (HEADER_OUT).
 * Compare with guest Chrome HAR when available.
 *
 *   node google-search-debug/scripts/capture-wire-headers.mjs --query test
 *
 * Env (set by script):
 *   VELORA_WIRE_HEADERS=1
 *   VELORA_WIRE_HEADERS_FILE=<tmp>/wire-headers.jsonl
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const HAR_PATH = resolve(REPO, "google-search-debug/www.google.com.har");
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

function normalizeName(name) {
    return String(name || "").toLowerCase();
}

async function harHop1Headers() {
    if (!existsSync(HAR_PATH)) return null;
    const har = JSON.parse(await readFile(HAR_PATH, "utf8"));
    const entry = har.log.entries.find((e) => {
        const u = new URL(e.request.url);
        return u.host.includes("google.") && u.pathname === "/search"
            && !u.searchParams.has("sei") && !u.searchParams.has("sg_ss");
    });
    if (!entry) return null;
    const headers = entry.request.headers.map((h) => ({
        name: h.name,
        value: h.value,
    }));
    return {
        url: entry.request.url,
        headerOrder: headers.map((h) => normalizeName(h.name)),
        headers,
    };
}

function diffWire(velora, har) {
    if (!har) return { note: "HAR missing — wire-only capture" };
    const vOrder = (velora.headerOrder || []).map(normalizeName);
    const hOrder = har.headerOrder;
    const onlyVelora = vOrder.filter((n) => !hOrder.includes(n));
    const onlyHar = hOrder.filter((n) => !vOrder.includes(n));
    const diffs = [];
    for (const name of new Set([...vOrder, ...hOrder])) {
        const v = velora.headers?.find((h) => normalizeName(h.name) === name)?.value;
        const h = har.headers.find((x) => normalizeName(x.name) === name)?.value;
        if (v !== h && (v || h)) diffs.push({ name, velora: v ?? null, har: h ?? null });
    }
    return { onlyVelora, onlyHar, orderMatch: vOrder.join("|") === hOrder.join("|"), valueDiffs: diffs };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const budget = createProbeBudget(args.maxSec, ({ signal }) => killProc(veloraProc, signal));
    let veloraProc = null;

    const outDir = resolve(REPO, `google-search-debug/tmp/wire-capture-${Date.now()}`);
    await mkdir(outDir, { recursive: true });
    const wireFile = resolve(outDir, "wire-headers.jsonl");

    try {
        const port = await getFreePort();
        const launch = await spawnVelora(args.profile, port, {
            env: {
                VELORA_WIRE_HEADERS: "1",
                VELORA_WIRE_HEADERS_FILE: wireFile,
            },
        });
        veloraProc = launch.proc;

        const url = buildSearchUrl(args.query);
        const conn = await connectCdp(launch.endpoint);
        const { client, sessionId } = conn;
        await client.send("Page.navigate", { url }, sessionId);

        let wire = null;
        while (budget.remaining() > 400) {
            await delay(200);
            if (existsSync(wireFile)) {
                const raw = await readFile(wireFile, "utf8");
                const line = raw.trim().split("\n").filter(Boolean).at(-1);
                if (line) {
                    wire = JSON.parse(line);
                    break;
                }
            }
        }

        if (!wire) throw new Error("wire header capture timeout — no VELORA_WIRE_HEADERS output");

        const har = await harHop1Headers();
        const diff = diffWire(wire, har);
        const report = { url, wire, har, diff };
        await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));

        console.log(`\n=== Velora wire hop-1 (${wire.headerCount} headers) ===`);
        console.log(`protocol: ${wire.protocol} status: ${wire.status}`);
        for (const line of wire.requestLines || []) console.log(line);
        for (const h of wire.headers || []) {
            console.log(`${h.name}: ${String(h.value).slice(0, 100)}`);
        }

        if (har) {
            console.log(`\n=== vs HAR (${har.headers.length} headers) ===`);
            console.log(`order match: ${diff.orderMatch}`);
            if (diff.onlyVelora?.length) console.log(`only Velora: ${diff.onlyVelora.join(", ")}`);
            if (diff.onlyHar?.length) console.log(`only HAR: ${diff.onlyHar.join(", ")}`);
            for (const d of (diff.valueDiffs || []).slice(0, 12)) {
                console.log(`  ${d.name}: velora=${JSON.stringify(d.velora)} har=${JSON.stringify(d.har)}`);
            }
        } else {
            console.log("\n(HAR not found — skip comparison)");
        }
        console.log(`\nsaved: ${outDir}/`);
    } finally {
        budget.clear();
        killProc(veloraProc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });