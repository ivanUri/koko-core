#!/usr/bin/env node
/**
 * Dump Knitsail program material (p, sp, window.sgs) from real Chrome via CDP.
 *
 * Prerequisite:
 *   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
 *
 * Usage:
 *   node code-check/sites/google/knitsail/dump.mjs
 *   CHROME_CDP=http://127.0.0.1:9222 node knitsail/dump.mjs --query test
 *   node knitsail/dump.mjs --spawn-chrome --query test
 *   node knitsail/dump.mjs --html ./chrome-hop1.html
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { connectChrome, pageUrl, withChromePage } from "../lib/chrome-cdp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const OUT = resolve(repoRoot, "code-check/tmp/knitsail-dump");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = {
        query: `knitsail-${Date.now()}`,
        html: null,
        source: "chrome-live",
        spawnChrome: false,
        endpoint: undefined,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
            i += 1;
            return argv[i];
        };
        switch (a) {
            case "--query": out.query = next(); break;
            case "--html": out.html = resolve(next()); out.source = "static-html"; break;
            case "--spawn-chrome": out.spawnChrome = true; break;
            case "--endpoint": out.endpoint = next(); break;
            case "--help":
                console.log("Usage: node dump.mjs [--query Q] [--endpoint URL] [--spawn-chrome] [--html path]");
                process.exit(0);
            default:
                throw new Error(`Unknown arg: ${a}`);
        }
    }
    return out;
}

const CAPTURE_HOOK = `(() => {
    const root = window.top;
    const store = root.__knitsailDump || (root.__knitsailDump = {
        vars: {},
        varHistory: [],
        sgsEvents: [],
        errors: [],
    });

    const record = (name, value, via) => {
        const entry = {
            t: performance.now(),
            name,
            via,
            type: typeof value,
            len: typeof value === "string" ? value.length : null,
            preview: typeof value === "string" ? value.slice(0, 120) : null,
        };
        store.varHistory.push(entry);
        if (typeof value === "string" && value.length > (store.vars[name]?.length || 0)) {
            store.vars[name] = value;
        } else if (store.vars[name] == null) {
            store.vars[name] = value;
        }
    };

    const watchGlobal = (name) => {
        try {
            let val = root[name];
            Object.defineProperty(root, name, {
                configurable: true,
                enumerable: true,
                get() { return val; },
                set(v) {
                    record(name, v, "defineProperty-set");
                    val = v;
                },
            });
            record(name, val, "init");
        } catch (e) {
            store.errors.push("watch " + name + ": " + String(e));
        }
    };

    for (const n of ["p", "sp", "ussv", "cbs", "hashed_query", "challenge_version", "g", "eid"]) {
        watchGlobal(n);
    }

    try {
        let sgsInner = root.sgs;
        Object.defineProperty(root, "sgs", {
            configurable: true,
            enumerable: true,
            get() { return sgsInner; },
            set(fn) {
                store.sgsEvents.push({
                    t: performance.now(),
                    phase: "assigned",
                    typeofFn: typeof fn,
                    sourceLen: typeof fn === "function" ? String(fn).length : 0,
                    sourcePreview: typeof fn === "function" ? String(fn).slice(0, 400) : null,
                });
                if (typeof fn !== "function") { sgsInner = fn; return; }
                sgsInner = function (...args) {
                    store.sgsEvents.push({
                        t: performance.now(),
                        phase: "call",
                        arg0Len: args[0] != null ? String(args[0]).length : 0,
                        arg0Preview: args[0] != null ? String(args[0]).slice(0, 120) : null,
                    });
                    const p = fn.apply(this, args);
                    if (p && typeof p.then === "function") {
                        return p.then(
                            (r) => {
                                store.sgsEvents.push({
                                    t: performance.now(),
                                    phase: "resolve",
                                    resultLen: r != null ? String(r).length : 0,
                                    resultPreview: r != null ? String(r).slice(0, 120) : null,
                                });
                                return r;
                            },
                            (e) => {
                                store.sgsEvents.push({
                                    t: performance.now(),
                                    phase: "reject",
                                    error: String(e),
                                    message: e?.message,
                                });
                                throw e;
                            },
                        );
                    }
                    return p;
                };
            },
        });
        record("sgs", sgsInner, "init");
    } catch (e) {
        store.errors.push("sgs trap: " + String(e));
    }

    let polls = 0;
    const poll = () => {
        polls += 1;
        try {
            for (const n of ["p", "sp", "ussv", "cbs"]) {
                const v = root[n];
                if (typeof v === "string" && v.length > 0) record(n, v, "poll");
            }
        } catch (e) {}
        if (polls < 800) setTimeout(poll, 10);
    };
    poll();
})()`;

function extractFromHtml(html) {
    const vars = {};
    for (const name of ["p", "sp", "ussv", "cbs", "g", "eid", "challenge_version", "hashed_query"]) {
        const q = html.match(new RegExp(`var ${name}='([^']*)'`));
        const d = html.match(new RegExp(`var ${name}="([^"]*)"`));
        const n = html.match(new RegExp(`var ${name}=(-?\\d+)`));
        if (q) vars[name] = q[1];
        else if (d) vars[name] = d[1];
        else if (n) vars[name] = n[1];
    }
    const knitsailIdx = html.indexOf("knitsail");
    const sgsBootstrap = html.match(/window\\.sgs&&ussv&&sp[\s\S]{0,400}/)?.[0] ?? null;
    return {
        source: "static-html",
        vars,
        htmlLen: html.length,
        scriptCount: (html.match(/<script[^>]*>/gi) || []).length,
        hasKnitsail: knitsailIdx >= 0,
        sgsBootstrap,
        knitsailOffset: knitsailIdx,
    };
}

async function dumpLive(opts) {
    const search = `https://www.google.com/search?q=${encodeURIComponent(opts.query)}&hl=en`;

    return withChromePage(async ({ page, session, endpoint }) => {
        await session.send("Page.addScriptToEvaluateOnNewDocument", { source: CAPTURE_HOOK });
        await session.send("Network.enable");

        const hops = [];
        session.on("Network.responseReceived", (p) => {
            if (p.type !== "Document") return;
            const url = p.response?.url || "";
            if (!url.includes("google.com")) return;
            hops.push({
                kind: url.includes("sg_ss=") ? "sg_ss"
                    : url.includes("sei=") ? "sei"
                        : url.includes("/sorry") ? "sorry"
                            : url.includes("/search") ? "search" : "other",
                status: p.response?.status,
                url: url.slice(0, 200),
            });
        });

        console.log(`[goto] ${search} (chrome ${endpoint})`);
        await page.goto(search, { waitUntil: "domcontentloaded", timeout: 90_000 });

        for (let i = 0; i < 120; i++) {
            const u = await pageUrl(page);
            if (u.includes("sg_ss=") || u.includes("/sorry")) break;
            if (/SearchResultsPage/.test(await page.content().catch(() => ""))) break;
            await delay(250);
        }
        await delay(2000);

        const dump = await page.evaluate(() => {
            const s = window.__knitsailDump || {};
            let ttEval = null;
            try {
                ttEval = eval(trustedTypes.createPolicy("kd", { createScript: (x) => x }).createScript("1")) === 1;
            } catch (e) {
                ttEval = String(e);
            }
            return {
                url: location.href,
                sorry: location.href.includes("/sorry"),
                serp: document.documentElement.innerHTML.includes("SearchResultsPage"),
                vars: s.vars || {},
                varHistory: (s.varHistory || []).slice(-40),
                sgsEvents: s.sgsEvents || [],
                errors: s.errors || [],
                ttEval,
                typeofSgs: typeof window.sgs,
                sgsSourceLen: typeof window.sgs === "function" ? String(window.sgs).length : 0,
                htmlLen: document.documentElement.outerHTML.length,
            };
        });

        const html = await page.content();
        return {
            source: "chrome-live",
            chromeEndpoint: endpoint,
            query: opts.query,
            search,
            hops,
            dump,
            html,
        };
    }, { spawn: opts.spawnChrome, endpoint: opts.endpoint, keepBrowser: true });
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    mkdirSync(OUT, { recursive: true });

    let result;
    if (opts.html) {
        const html = readFileSync(opts.html, "utf8");
        result = extractFromHtml(html);
        result.html = html;
        result.query = opts.query;
    } else {
        result = await dumpLive(opts);
    }

    writeFileSync(resolve(OUT, "dump.json"), JSON.stringify({ ...result, html: undefined }, null, 2));
    if (result.html) writeFileSync(resolve(OUT, "page.html"), result.html);

    const vars = result.dump?.vars || result.vars || {};
    console.log("\n=== Knitsail dump (real Chrome) ===");
    console.log(`source: ${result.source}`);
    if (result.chromeEndpoint) console.log(`cdp:    ${result.chromeEndpoint}`);
    if (result.dump) {
        console.log(`final:  ${result.dump.url?.slice(0, 100)}`);
        console.log(`serp=${result.dump.serp} sorry=${result.dump.sorry} ttEval=${result.dump.ttEval}`);
        console.log(`sgs: ${result.dump.typeofSgs} events=${(result.dump.sgsEvents || []).map((e) => e.phase).join(" → ") || "(none)"}`);
    }
    for (const [k, v] of Object.entries(vars)) {
        console.log(`  ${k}: len=${typeof v === "string" ? v.length : 0} preview=${String(v).slice(0, 60)}`);
    }
    if (result.hops?.length) {
        console.log("hops:", result.hops.map((h) => `${h.kind}:${h.status}`).join(" → "));
    }
    console.log(`\nsaved: ${OUT}/dump.json`);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});