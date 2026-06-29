#!/usr/bin/env node
/**
 * Capture Velora wire headers for all /search document hops (initial, sei, sg_ss)
 * and compare sei hop vs Chrome CDP request headers.
 *
 *   node google-search-debug/scripts/capture-wire-search-hops.mjs --query test --max-sec 25
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
    REPO,
    buildSearchUrl,
    connectCdp,
    getFreePort,
    spawnVelora,
    resolveGoogleChromeSession,
    killProc,
} from "../lib/cdp.mjs";
import {
    createProbeBudget,
    parseMaxSecArg,
} from "../../scripts/lib/cdp-probe-budget.mjs";

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

function headerMap(headers) {
    const out = {};
    for (const h of headers || []) {
        out[normalizeName(h.name)] = h.value;
    }
    return out;
}

function parseCookieHeader(cookie) {
    if (!cookie) return { names: [], len: 0 };
    const names = cookie.split(";").map((p) => p.trim().split("=")[0]).filter(Boolean);
    return { names, len: cookie.length };
}

function summarizeWire(wire) {
    const map = headerMap(wire.headers);
    const cookie = parseCookieHeader(map.cookie);
    return {
        hop: wire.hop || classifyHop(wire.url),
        url: wire.url,
        status: wire.status,
        protocol: wire.protocol,
        headerCount: wire.headerCount ?? wire.headers?.length ?? 0,
        headerNames: (wire.headerOrder || wire.headers?.map((h) => normalizeName(h.name)) || []),
        referer: map.referer ?? null,
        secFetchSite: map["sec-fetch-site"] ?? null,
        secFetchMode: map["sec-fetch-mode"] ?? null,
        secFetchDest: map["sec-fetch-dest"] ?? null,
        secFetchUser: map["sec-fetch-user"] ?? null,
        acceptEncoding: map["accept-encoding"] ?? null,
        cacheControl: map["cache-control"] ?? null,
        pragma: map.pragma ?? null,
        cookieLen: cookie.len,
        cookieNames: cookie.names,
        userAgent: map["user-agent"]?.slice(0, 120) ?? null,
        headers: wire.headers,
    };
}

function summarizeCdp(req, res) {
    const raw = req?.headers || {};
    const headers = Object.entries(raw).map(([name, value]) => ({ name, value: String(value) }));
    const map = headerMap(headers);
    const cookie = parseCookieHeader(map.cookie);
    return {
        hop: classifyHop(req?.url),
        url: req?.url,
        status: res?.status,
        protocol: res?.protocol,
        headerCount: headers.length,
        headerNames: headers.map((h) => normalizeName(h.name)),
        referer: map.referer ?? null,
        secFetchSite: map["sec-fetch-site"] ?? null,
        secFetchMode: map["sec-fetch-mode"] ?? null,
        secFetchDest: map["sec-fetch-dest"] ?? null,
        secFetchUser: map["sec-fetch-user"] ?? null,
        acceptEncoding: map["accept-encoding"] ?? null,
        cacheControl: map["cache-control"] ?? null,
        pragma: map.pragma ?? null,
        cookieLen: cookie.len,
        cookieNames: cookie.names,
        userAgent: map["user-agent"]?.slice(0, 120) ?? null,
        headers,
    };
}

function diffSummaries(a, b, label) {
    const keys = [
        "protocol", "status", "headerCount", "cookieLen", "cookieNames",
        "referer", "secFetchSite", "secFetchMode", "secFetchDest", "secFetchUser",
        "acceptEncoding", "cacheControl", "pragma",
    ];
    const out = [];
    for (const k of keys) {
        if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) {
            out.push({ field: `${label}.${k}`, velora: a?.[k], chrome: b?.[k] });
        }
    }
    const orderA = a?.headerNames || [];
    const orderB = b?.headerNames || [];
    if (orderA.join("|") !== orderB.join("|")) {
        out.push({ field: `${label}.headerOrder`, velora: orderA, chrome: orderB });
    }
    const onlyV = orderA.filter((n) => !orderB.includes(n));
    const onlyC = orderB.filter((n) => !orderA.includes(n));
    if (onlyV.length || onlyC.length) {
        out.push({ field: `${label}.headerPresence`, onlyVelora: onlyV, onlyChrome: onlyC });
    }
    return out;
}

async function readWireHops(wireFile) {
    const raw = await readFile(wireFile, "utf8");
    const hops = {};
    for (const line of raw.trim().split("\n").filter(Boolean)) {
        const entry = JSON.parse(line);
        const hop = entry.hop || classifyHop(entry.url);
        if (hop) hops[hop] = summarizeWire(entry);
    }
    return hops;
}

async function captureChromeSearchHops({ endpoint, url, budget }) {
    const hops = {};
    const conn = await connectCdp(endpoint);
    const { client, sessionId } = conn;

    const requests = new Map();
    client.ws.on("message", (raw) => {
        try {
            const msg = JSON.parse(String(raw));
            if (msg.sessionId && msg.sessionId !== sessionId) return;
            const p = msg.params || {};
            if (msg.method === "Network.requestWillBeSent" && p.type === "Document") {
                requests.set(p.requestId, { req: p.request, ts: Date.now() });
            }
            if (msg.method === "Network.responseReceived" && p.type === "Document") {
                const hop = classifyHop(p.response?.url);
                if (!hop || hops[hop]) return;
                const req = requests.get(p.requestId)?.req || {
                    url: p.response.url,
                    method: "GET",
                    headers: p.response.requestHeaders,
                };
                hops[hop] = summarizeCdp(req, p.response);
            }
        } catch {}
    });

    try {
        await client.send("Network.enable", {}, sessionId);
        await client.send("Page.navigate", { url }, sessionId);
        while (budget.remaining() > 500) {
            await delay(300);
            if (hops.sei) break;
        }
        return hops;
    } finally {
        client.close();
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const budget = createProbeBudget(args.maxSec, ({ signal }) => {
        killProc(veloraProc, signal);
        killProc(chromeProc, signal);
    });

    let veloraProc = null;
    let chromeProc = null;
    const url = buildSearchUrl(args.query, { hl: "en" });
    const outDir = resolve(REPO, `google-search-debug/tmp/wire-search-hops-${Date.now()}`);
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

        const chromeSession = await resolveGoogleChromeSession({
            profileDir: `/tmp/velora-wire-sei-chrome-${Date.now()}`,
        });
        chromeProc = chromeSession.proc;

        console.log(`[parallel] ${url}`);

        const veloraNav = (async () => {
            const conn = await connectCdp(launch.endpoint);
            const { client, sessionId } = conn;
            try {
                await client.send("Page.navigate", { url }, sessionId);
                while (budget.remaining() > 500) {
                    await delay(250);
                    if (!existsSync(wireFile)) continue;
                    const hops = await readWireHops(wireFile);
                    if (hops.sei) return hops;
                }
                if (existsSync(wireFile)) return await readWireHops(wireFile);
                throw new Error("Velora wire capture timeout — no sei hop in jsonl");
            } finally {
                client.close();
            }
        })();

        const [veloraHops, chromeHops] = await Promise.all([
            veloraNav,
            captureChromeSearchHops({ endpoint: chromeSession.endpoint, url, budget }),
        ]);

        const diff = [
            ...diffSummaries(veloraHops.initial, chromeHops.initial, "initial"),
            ...diffSummaries(veloraHops.sei, chromeHops.sei, "sei"),
        ];
        if (veloraHops.sg_ss) {
            diff.push({ field: "velora.sg_ss", note: "captured", url: veloraHops.sg_ss.url });
        }

        const report = { url, velora: veloraHops, chrome: chromeHops, diff };
        await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));

        for (const hop of ["initial", "sei", "sg_ss"]) {
            const v = veloraHops[hop];
            const c = chromeHops[hop];
            if (!v && !c) continue;
            console.log(`\n=== ${hop} hop ===`);
            if (v) {
                console.log(`Velora wire: ${v.status} ${v.protocol} headers=${v.headerCount} cookies=${v.cookieNames.length}`);
                console.log(`  referer: ${v.referer || "(none)"}`);
                console.log(`  sec-fetch-site: ${v.secFetchSite} mode: ${v.secFetchMode} dest: ${v.secFetchDest}`);
            } else {
                console.log("Velora wire: (not captured)");
            }
            if (c) {
                console.log(`Chrome CDP: ${c.status} ${c.protocol} headers=${c.headerCount} cookies=${c.cookieNames.length}`);
                console.log(`  referer: ${c.referer || "(none)"}`);
                console.log(`  sec-fetch-site: ${c.secFetchSite} mode: ${c.secFetchMode} dest: ${c.secFetchDest}`);
            } else {
                console.log("Chrome CDP: (not captured)");
            }
        }

        console.log(`\n=== Velora initial → sei wire delta ===`);
        if (veloraHops.initial && veloraHops.sei) {
            const id = diffSummaries(veloraHops.initial, veloraHops.sei, "velora.initial→sei");
            for (const d of id.slice(0, 15)) {
                if (d.onlyVelora || d.onlyChrome) {
                    if (d.onlyVelora?.length) console.log(`- only initial: ${d.onlyVelora.join(", ")}`);
                    if (d.onlyChrome?.length) console.log(`- only sei: ${d.onlyChrome.join(", ")}`);
                } else if (!d.field?.includes("headerOrder")) {
                    console.log(`- ${d.field}: initial=${JSON.stringify(d.velora)} sei=${JSON.stringify(d.chrome)}`);
                }
            }
        }

        console.log(`\n=== sei Velora wire vs Chrome CDP (${diff.filter((d) => d.field?.startsWith("sei")).length} diffs) ===`);
        for (const d of diff.filter((x) => x.field?.startsWith("sei"))) {
            if (d.onlyVelora?.length) console.log(`- only Velora: ${d.onlyVelora.join(", ")}`);
            else if (d.onlyChrome?.length) console.log(`- only Chrome: ${d.onlyChrome.join(", ")}`);
            else if (d.note) console.log(`- ${d.field}: ${d.note}`);
            else console.log(`- ${d.field}: velora=${JSON.stringify(d.velora)} chrome=${JSON.stringify(d.chrome)}`);
        }

        console.log(`\nsaved: ${outDir}/`);
    } finally {
        budget.clear();
        killProc(veloraProc);
        killProc(chromeProc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });