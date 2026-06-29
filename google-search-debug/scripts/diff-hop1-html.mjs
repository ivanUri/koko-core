#!/usr/bin/env node
/**
 * Capture and diff hop-1 (/search?q=, no sei) document HTML: Chrome vs Velora.
 *
 *   node google-search-debug/scripts/diff-hop1-html.mjs --query test
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
    REPO,
    buildSearchUrl,
    connectCdp,
    getFreePort,
    spawnVelora,
    resolveGoogleChromeSession,
    killProc,
    enableNetworkBodyCapture,
    attachDocumentBodyCapture,
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

function classifySearchHop(url) {
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

function extractInlineScripts(html) {
    const out = [];
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
        if (/src\s*=/i.test(m[1] || "")) continue;
        const body = (m[2] || "").trim();
        if (body) out.push(body);
    }
    return out;
}

function firstDiff(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
        if (a[i] !== b[i]) {
            return {
                index: i,
                a: a[i],
                b: b[i],
                ctxA: a.slice(Math.max(0, i - 40), i + 40),
                ctxB: b.slice(Math.max(0, i - 40), i + 40),
            };
        }
    }
    if (a.length !== b.length) {
        return { index: n, lenA: a.length, lenB: b.length, tailA: a.slice(-80), tailB: b.slice(-80) };
    }
    return null;
}

function extractPToken(script) {
    const m = script.match(/(?:^|[;,])\s*p\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\d+)/);
    return m ? m[1] : null;
}

function diffScripts(veloraHtml, chromeHtml) {
    const vScripts = extractInlineScripts(veloraHtml);
    const cScripts = extractInlineScripts(chromeHtml);
    const names = ["script0", "script1", "script2-knitsail", "script3-bootstrap", "script4"];
    const out = {};
    const max = Math.max(vScripts.length, cScripts.length);
    for (let i = 0; i < max; i += 1) {
        const v = vScripts[i] || "";
        const c = cScripts[i] || "";
        const name = names[i] || `script${i}`;
        const entry = {
            veloraLen: v.length,
            chromeLen: c.length,
            lenDelta: v.length - c.length,
            identical: v === c,
            firstDiff: v && c && v !== c ? firstDiff(v, c) : null,
        };
        if (name === "script3-bootstrap") {
            entry.pTokenVelora = extractPToken(v);
            entry.pTokenChrome = extractPToken(c);
            entry.pTokenMatch = entry.pTokenVelora === entry.pTokenChrome;
        }
        out[name] = entry;
    }
    return out;
}

function analyzeHtml(html, meta) {
    const inline = [];
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
        const attrs = m[1] || "";
        const body = m[2] || "";
        if (/src\s*=/i.test(attrs)) continue;
        if (!body.trim()) continue;
        inline.push({ len: body.length });
    }

    const pick = (name) => {
        const reVar = new RegExp(`(?:var|let|const)\\s+${name}=([^;]+)`);
        const hit = html.match(reVar);
        return hit ? hit[1].trim().slice(0, 80) : null;
    };

    const script3 = (() => {
        const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
            .filter((x) => !x[1].includes("src") && (x[2] || "").trim());
        return scripts[3]?.[2] || scripts[2]?.[2] || "";
    })();

    return {
        ...meta,
        htmlLen: html.length,
        inlineScriptCount: inline.length,
        inlineScriptLens: inline.map((s) => s.len),
        knitsailLoaderLen: inline[2]?.len ?? null,
        bootstrapLen: inline[3]?.len ?? null,
        sclm: pick("sclm"),
        sctm: pick("sctm"),
        ss_cgi: pick("ss_cgi"),
        sp: pick("sp"),
        ussv: pick("ussv"),
        hasWindowSgsRef: html.includes("window.sgs"),
        hasKnitsail: html.includes("knitsail"),
        hasSgSsInHtml: html.includes("sg_ss"),
        script3Head: script3.slice(0, 120).replace(/\s+/g, " "),
    };
}

async function captureHops({ endpoint, url, label, budget }) {
    const hops = [];
    const bodies = { initial: null, sei: null, sg_ss: null };
    const metas = { initial: null, sei: null, sg_ss: null };

    const conn = await connectCdp(endpoint);
    const { client, sessionId } = conn;

    const onBody = async (requestId, response, html, err) => {
        const kind = classifySearchHop(response.url);
        const entry = {
            requestId,
            url: response.url,
            status: response.status,
            protocol: response.protocol,
            kind,
        };
        hops.push(entry);
        if (!kind || bodies[kind]) return;
        metas[kind] = entry;
        if (err) {
            metas[kind].bodyError = err;
            return;
        }
        bodies[kind] = html;
    };

    const bodyHandler = attachDocumentBodyCapture(client, sessionId, onBody);
    client.ws.on("message", (raw) => { bodyHandler(raw).catch(() => {}); });

    try {
        await enableNetworkBodyCapture(client, sessionId);
        await client.send("Page.navigate", { url }, sessionId);

        while (budget.remaining() > 500) {
            await delay(300);
            if (bodies.initial && bodies.sei) break;
            if (hops.some((h) => h.url?.includes("/sorry"))) break;
        }

        const analyzed = {};
        for (const kind of ["initial", "sei", "sg_ss"]) {
            analyzed[kind] = bodies[kind]
                ? analyzeHtml(bodies[kind], { ...metas[kind], kind })
                : null;
        }

        return {
            label,
            hops,
            analyzed,
            html: bodies,
        };
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
    const results = {};

    try {
        const veloraPort = await getFreePort();
        const launch = await spawnVelora(args.profile, veloraPort);
        veloraProc = launch.proc;
        console.log(`[velora] ${url}`);
        results.velora = await captureHops({
            endpoint: launch.endpoint,
            url,
            label: "velora",
            budget,
        });

        const chromeSession = await resolveGoogleChromeSession({
            profileDir: `/tmp/velora-hop1-diff-chrome-${Date.now()}`,
        });
        chromeProc = chromeSession.proc;
        console.log(`[chrome] ${url}`);
        results.chrome = await captureHops({
            endpoint: chromeSession.endpoint,
            url,
            label: "chrome",
            budget,
        });

        const outDir = resolve(REPO, `google-search-debug/tmp/hop1-diff-${Date.now()}`);
        await mkdir(outDir, { recursive: true });

        for (const kind of ["initial", "sei", "sg_ss"]) {
            if (results.velora.html?.[kind]) {
                await writeFile(resolve(outDir, `velora-${kind}.html`), results.velora.html[kind]);
            }
            if (results.chrome.html?.[kind]) {
                await writeFile(resolve(outDir, `chrome-${kind}.html`), results.chrome.html[kind]);
            }
        }

        const scriptDiff = {};
        for (const kind of ["initial", "sei"]) {
            const vHtml = results.velora.html?.[kind];
            const cHtml = results.chrome.html?.[kind];
            scriptDiff[kind] = vHtml && cHtml ? diffScripts(vHtml, cHtml) : null;
        }

        const report = {
            url,
            velora: results.velora.analyzed,
            chrome: results.chrome.analyzed,
            scriptDiff,
            diff: { initial: [], sei: [] },
        };
        delete results.velora.html;
        delete results.chrome.html;

        const keys = [
            "htmlLen", "inlineScriptCount", "inlineScriptLens", "knitsailLoaderLen", "bootstrapLen",
            "sclm", "sctm", "ss_cgi", "sp", "ussv", "hasWindowSgsRef", "hasKnitsail", "hasSgSsInHtml",
            "status", "protocol",
        ];
        for (const hop of ["initial", "sei"]) {
            for (const k of keys) {
                const v = report.velora[hop]?.[k];
                const c = report.chrome[hop]?.[k];
                if (JSON.stringify(v) !== JSON.stringify(c)) {
                    report.diff[hop].push({ field: k, velora: v, chrome: c });
                }
            }
        }

        await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));

        for (const hop of ["initial", "sei"]) {
            console.log(`\n=== ${hop} hop HTML diff ===`);
            const diffs = report.diff[hop];
            if (!diffs.length) {
                console.log("(identical analyzed fields)");
            } else {
                for (const d of diffs) {
                    console.log(`${d.field}: velora=${JSON.stringify(d.velora)} chrome=${JSON.stringify(d.chrome)}`);
                }
            }
            const sd = scriptDiff[hop];
            if (sd) {
                console.log(`\n--- ${hop} inline script bytes ---`);
                for (const [name, s] of Object.entries(sd)) {
                    if (!s.veloraLen && !s.chromeLen) continue;
                    const tag = s.identical ? "IDENTICAL" : `delta=${s.lenDelta}`;
                    console.log(`${name}: velora=${s.veloraLen} chrome=${s.chromeLen} ${tag}`);
                    if (name === "script3-bootstrap" && (s.pTokenVelora || s.pTokenChrome)) {
                        console.log(`  p= velora=${s.pTokenVelora ?? "null"} chrome=${s.pTokenChrome ?? "null"} match=${s.pTokenMatch}`);
                    }
                    if (s.firstDiff) {
                        console.log(`  firstDiff@${s.firstDiff.index}: velora=${JSON.stringify(s.firstDiff.ctxA)}`);
                        console.log(`              chrome=${JSON.stringify(s.firstDiff.ctxB)}`);
                    }
                }
            } else {
                console.log(`(no ${hop} HTML pair for script diff)`);
                const err = results.chrome.analyzed?.[hop]?.bodyError;
                if (err) console.log(`  chrome bodyError: ${err}`);
            }
        }
        console.log(`\nDocument hops:`);
        console.log(`  velora: ${results.velora.hops.map((h) => h.url?.split("?")[0] + (h.url?.includes("sei=") ? "+sei" : "")).join(" → ")}`);
        console.log(`  chrome: ${results.chrome.hops.map((h) => h.url?.split("?")[0] + (h.url?.includes("sei=") ? "+sei" : "")).join(" → ")}`);
        console.log(`saved: ${outDir}/`);
    } finally {
        budget.clear();
        killProc(veloraProc);
        killProc(chromeProc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });