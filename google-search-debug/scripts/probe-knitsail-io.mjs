#!/usr/bin/env node
/**
 * Trace knitsail.a() I/O across document hops (initial, sei, sg_ss).
 * Persists via sessionStorage so hop-2 sei is captured after replace.
 *
 *   node google-search-debug/scripts/probe-knitsail-io.mjs --query test --max-sec 25
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
} from "../lib/cdp.mjs";
import {
    createProbeBudget,
    evaluateWithTimeout,
    parseMaxSecArg,
} from "../../scripts/lib/cdp-probe-budget.mjs";

const HOOK = `(() => {
    const STORE_KEY = "__knitsailIoPersist";

    const classifyHop = (href) => {
        try {
            const u = new URL(href);
            if (!u.host.includes("google.")) return "other";
            if (u.pathname === "/sorry/index" || u.pathname.startsWith("/sorry")) return "sorry";
            if (u.pathname !== "/search") return "other";
            if (u.searchParams.has("sg_ss")) return "sg_ss";
            if (u.searchParams.has("sei")) return "sei";
            return "initial";
        } catch {
            return "unknown";
        }
    };

    const loadStore = () => {
        try {
            const raw = sessionStorage.getItem(STORE_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch {
            return null;
        }
    };

    const emptyStore = () => ({
        calls: [],
        replaces: [],
        cookies: [],
        beacons: [],
        errors: [],
        docHops: [],
    });

    const prior = loadStore();
    window.__knitsailIo = prior || emptyStore();

    const flush = () => {
        try { sessionStorage.setItem(STORE_KEY, JSON.stringify(window.__knitsailIo)); } catch {}
    };

    const clip = (s, n = 120) => (typeof s === "string" ? s.slice(0, n) : s);

    const serializeArg = (a, i) => {
        if (a === null) return { i, type: "null" };
        const t = typeof a;
        if (t === "string") {
            return { i, type: "string", len: a.length, head: clip(a, 80), tail: a.length > 80 ? a.slice(-40) : null };
        }
        if (t === "number" || t === "boolean" || t === "bigint") return { i, type: t, value: a };
        if (t === "function") return { i, type: "function", name: a.name || "", len: a.length };
        if (t === "object") {
            try {
                const keys = Object.keys(a).slice(0, 24);
                return { i, type: Array.isArray(a) ? "array" : "object", keys, len: Array.isArray(a) ? a.length : keys.length };
            } catch (e) {
                return { i, type: "object", err: String(e.message || e) };
            }
        }
        return { i, type: t };
    };

    const snapEnv = (tag) => {
        const p = performance?.timing || {};
        let haVal = null;
        try { haVal = typeof ha === "function" ? ha() : null; } catch (e) { haVal = "err:" + e.message; }
        return {
            tag,
            href: location.href,
            rs: document.readyState,
            pageT: window.chrome?.csi?.()?.pageT ?? null,
            perfNow: performance?.now?.() ?? null,
            sn: window.google?.sn ?? null,
            kei: window.google?.kEI ?? null,
            ha: haVal,
            td: window.td ? { ...window.td } : null,
            cookieLen: document.cookie?.length ?? 0,
            timing: {
                ns: p.navigationStart,
                rs: p.responseStart,
                dcl: p.domContentLoadedEventEnd,
                le: p.loadEventEnd,
            },
        };
    };

    const deepWrap = (fn, rec, path, depth = 0) => {
        if (depth > 8) return fn;
        return function (...cbArgs) {
            const hit = { path, depth, argc: cbArgs.length, argTypes: cbArgs.map((x) => (x === null ? "null" : typeof x)), strings: [] };
            const inner = cbArgs.slice();
            for (let i = 0; i < inner.length; i += 1) {
                const a = inner[i];
                if (typeof a === "string" && a.length >= 8) {
                    hit.strings.push({
                        i,
                        len: a.length,
                        head: clip(a, 96),
                        tail: a.length > 96 ? a.slice(-48) : null,
                    });
                }
                if (typeof a === "function") {
                    inner[i] = deepWrap(a, rec, path + "." + i, depth + 1);
                }
            }
            if (hit.strings.length) rec.stringHits = (rec.stringHits || []).concat(hit);
            rec.callbackOut = hit;
            try {
                return fn.apply(this, inner);
            } catch (e) {
                hit.err = String(e.message || e);
                throw e;
            }
        };
    };

    const hookKnitsail = () => {
        const k = globalThis.knitsail;
        if (!k || k.__ioHook || typeof k.a !== "function") return false;
        const origA = k.a;
        k.a = function (...args) {
            const rec = {
                hop: classifyHop(location.href),
                ts: Date.now(),
                before: snapEnv("before-a"),
                argsIn: args.map(serializeArg),
                stringHits: [],
                callbackOut: null,
                return: null,
                after: null,
                err: null,
            };
            const wrapped = args.slice();
            for (let idx = 0; idx < wrapped.length; idx += 1) {
                if (typeof wrapped[idx] !== "function") continue;
                wrapped[idx] = deepWrap(wrapped[idx], rec, "arg" + idx);
            }
            try {
                const ret = origA.apply(this, wrapped);
                rec.return = (ret && typeof ret === "object" && typeof ret.then === "function")
                    ? { type: "promise" }
                    : serializeArg(ret, -1);
                if (ret && typeof ret.then === "function") {
                    ret.then((v) => {
                        rec.promiseResolve = serializeArg(v, -2);
                    }).catch((e) => {
                        rec.promiseReject = String(e.message || e);
                    });
                }
                rec.after = snapEnv("after-a");
                window.__knitsailIo.calls.push(rec);
                flush();
                return ret;
            } catch (e) {
                rec.err = String(e.message || e);
                rec.after = snapEnv("after-a-err");
                window.__knitsailIo.calls.push(rec);
                flush();
                throw e;
            }
        };
        k.__ioHook = true;
        return true;
    };

    const origReplace = location.replace.bind(location);
    location.replace = function (u) {
        const s = String(u);
        const sg = (() => {
            try {
                const v = new URL(s, location.origin).searchParams.get("sg_ss");
                return v ? { len: v.length, head: v.slice(0, 64), hasStar: v.startsWith("*") } : null;
            } catch { return null; }
        })();
        window.__knitsailIo.replaces.push({
            hop: classifyHop(location.href),
            url: s,
            len: s.length,
            sg_ss: sg,
            sei: s.includes("sei="),
        });
        flush();
        return origReplace(u);
    };

    const desc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")
        || Object.getOwnPropertyDescriptor(HTMLDocument.prototype, "cookie");
    if (desc?.set) {
        const origSet = desc.set;
        Object.defineProperty(document, "cookie", {
            ...desc,
            set(v) {
                const s = String(v);
                if (s.startsWith("SG_SS=") || s.includes("SG_SS=")) {
                    const val = s.split(";")[0];
                    window.__knitsailIo.cookies.push({
                        hop: classifyHop(location.href),
                        len: val.length,
                        head: val.slice(0, 80),
                    });
                    flush();
                }
                return origSet.call(this, v);
            },
        });
    }

    const sb = navigator.sendBeacon?.bind(navigator);
    if (sb) {
        navigator.sendBeacon = function (url, data) {
            const u = String(url);
            if (u.includes("gen_204")) {
                window.__knitsailIo.beacons.push({
                    cad: (u.match(/[?&]cad=([^&]+)/) || [])[1] || null,
                    err: (u.match(/[?&]e=([^&]+)/) || [])[1] || null,
                });
            }
            return sb(url, data);
        };
    }

    const onHop = () => {
        hookKnitsail();
        const k = classifyHop(location.href);
        const last = window.__knitsailIo.docHops.at(-1);
        if (!last || last.hop !== k || last.href !== location.href) {
            window.__knitsailIo.docHops.push({ hop: k, href: location.href, ts: Date.now() });
            flush();
        }
    };

    document.addEventListener("DOMContentLoaded", onHop);
    window.addEventListener("pageshow", onHop);
    window.addEventListener("pagehide", flush);
    const iv = setInterval(onHop, 3);
    setTimeout(() => clearInterval(iv), 25000);
})();`;

const READ = `(() => {
    const STORE_KEY = "__knitsailIoPersist";
    const empty = { calls: [], replaces: [], cookies: [], beacons: [], docHops: [] };
    let io = window.__knitsailIo || empty;
    try {
        const raw = sessionStorage.getItem(STORE_KEY);
        if (raw) {
            const p = JSON.parse(raw);
            const mergeArr = (a, b) => [...(a || []), ...(b || [])];
            io = {
                calls: mergeArr(p.calls, io.calls),
                replaces: mergeArr(p.replaces, io.replaces),
                cookies: mergeArr(p.cookies, io.cookies),
                beacons: mergeArr(p.beacons, io.beacons),
                docHops: mergeArr(p.docHops, io.docHops),
                errors: mergeArr(p.errors, io.errors),
            };
        }
    } catch {}
    const byHop = (arr) => {
        const out = { initial: 0, sei: 0, sg_ss: 0, sorry: 0, other: 0 };
        for (const x of arr || []) {
            const k = x.hop || "other";
            out[k] = (out[k] || 0) + 1;
        }
        return out;
    };
    return {
        href: location.href,
        title: document.title?.slice(0, 120),
        currentHop: (() => {
            try {
                const u = new URL(location.href);
                if (u.searchParams.has("sg_ss")) return "sg_ss";
                if (u.searchParams.has("sei")) return "sei";
                if (u.pathname.includes("sorry")) return "sorry";
                return "initial";
            } catch { return "unknown"; }
        })(),
        io,
        callCount: io.calls?.length ?? 0,
        callsByHop: byHop(io.calls),
        replacesByHop: byHop(io.replaces),
    };
})()`;

function parseArgs(argv) {
    const out = {
        engines: ["velora", "chrome"],
        profile: "chrome-local-huys-macbook-pro",
        query: "test",
        maxSec: parseMaxSecArg(argv),
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--engine") out.engines = [argv[++i]];
        else if (a === "--profile") out.profile = argv[++i];
        else if (a === "--query") out.query = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
    }
    return out;
}

function firstStringDiff(a, b) {
    if (!a || !b) return { note: "missing", aLen: a?.len, bLen: b?.len };
    if (a.head === b.head && a.len === b.len) return null;
    const ah = a.head || "";
    const bh = b.head || "";
    const n = Math.min(ah.length, bh.length);
    for (let i = 0; i < n; i += 1) {
        if (ah[i] !== bh[i]) {
            return { index: i, a: ah[i], b: bh[i], ctxA: ah.slice(Math.max(0, i - 20), i + 30), ctxB: bh.slice(Math.max(0, i - 20), i + 30), lenA: a.len, lenB: b.len };
        }
    }
    return { index: n, lenA: a.len, lenB: b.len, tailA: a.tail, tailB: b.tail };
}

function pickEncoded(call) {
    const hits = call?.stringHits || [];
    const candidates = [];
    for (const h of hits) {
        for (const s of h.strings || []) {
            if (s.len >= 16 && s.len <= 4096) candidates.push({ ...s, path: h.path, depth: h.depth });
        }
    }
    candidates.sort((a, b) => a.len - b.len);
    return candidates.at(-1) || null;
}

function summarizeHopCalls(calls, hop) {
    const hopCalls = (calls || []).filter((c) => c.hop === hop);
    const call = hopCalls[0] ?? null;
    return {
        callCount: hopCalls.length,
        pageT: call?.before?.pageT ?? null,
        arg0: call?.argsIn?.[0] ?? null,
        arg2: call?.argsIn?.[2] ?? null,
        arg7: call?.argsIn?.[7] ?? null,
        encoded: pickEncoded(call),
        sgCookie: null,
        sn: call?.after?.sn ?? call?.before?.sn ?? null,
    };
}

function summarizeEngine(data) {
    const io = data?.io || {};
    const calls = io.calls || [];
    const hopSummaries = {
        initial: summarizeHopCalls(calls, "initial"),
        sei: summarizeHopCalls(calls, "sei"),
        sg_ss: summarizeHopCalls(calls, "sg_ss"),
    };
    for (const h of ["initial", "sei", "sg_ss"]) {
        const c = (io.cookies || []).find((x) => x.hop === h);
        if (c) hopSummaries[h].sgCookie = c;
    }
    const firstCall = calls[0] ?? null;
    return {
        callCount: calls.length,
        callsByHop: data?.callsByHop ?? {},
        replacesByHop: data?.replacesByHop ?? {},
        docHops: io.docHops ?? [],
        replaceCount: io.replaces?.length ?? 0,
        cookieWrites: io.cookies?.length ?? 0,
        beacons: io.beacons ?? [],
        hopSummaries,
        pageT: firstCall?.before?.pageT ?? null,
        arg0: firstCall?.argsIn?.[0] ?? null,
        encoded: pickEncoded(firstCall),
        sgCookie: io.cookies?.[0] ?? null,
        replaceSg: io.replaces?.find((r) => r.sg_ss)?.sg_ss ?? null,
        replaceSei: io.replaces?.some((r) => r.sei) ?? false,
        currentHop: data?.currentHop ?? null,
        finalHref: data?.href ?? null,
        title: data?.title ?? null,
    };
}

function diffEngines(velora, chrome) {
    const v = summarizeEngine(velora);
    const c = summarizeEngine(chrome);
    const diffs = [];
    if (v.callCount !== c.callCount) diffs.push({ field: "knitsail.a calls (total)", velora: v.callCount, chrome: c.callCount });
    if (JSON.stringify(v.callsByHop) !== JSON.stringify(c.callsByHop)) {
        diffs.push({ field: "calls by hop", velora: v.callsByHop, chrome: c.callsByHop });
    }
    for (const hop of ["initial", "sei", "sg_ss"]) {
        const vh = v.hopSummaries[hop];
        const ch = c.hopSummaries[hop];
        if (vh.callCount !== ch.callCount) {
            diffs.push({ field: `knitsail.a @${hop}`, velora: vh.callCount, chrome: ch.callCount });
        }
        const encDiff = firstStringDiff(vh.encoded, ch.encoded);
        if (encDiff && (vh.encoded || ch.encoded)) {
            diffs.push({ field: `encoded @${hop}`, ...encDiff });
        }
        if (vh.sn !== ch.sn) diffs.push({ field: `google.sn @${hop}`, velora: vh.sn, chrome: ch.sn });
    }
    if (v.replaceCount !== c.replaceCount) diffs.push({ field: "location.replace", velora: v.replaceCount, chrome: c.replaceCount });
    if (JSON.stringify(v.replacesByHop) !== JSON.stringify(c.replacesByHop)) {
        diffs.push({ field: "replaces by hop", velora: v.replacesByHop, chrome: c.replacesByHop });
    }
    return { velora: v, chrome: c, diffs };
}

async function capture({ endpoint, url, label, budget }) {
    const hops = [];
    const conn = await connectCdp(endpoint);
    const { client, sessionId } = conn;

    client.ws.on("message", (raw) => {
        try {
            const m = JSON.parse(String(raw));
            if (m.sessionId && m.sessionId !== sessionId) return;
            const p = m.params || {};
            if (m.method === "Network.requestWillBeSent" && p.type === "Document") {
                hops.push({ url: p.request?.url, ts: Date.now() });
            }
        } catch {}
    });

    try {
        await client.send("Page.addScriptToEvaluateOnNewDocument", { source: HOOK }, sessionId);
        await client.send("Network.enable", {}, sessionId);
        await evaluateWithTimeout(
            client,
            sessionId,
            `(() => { try { sessionStorage.removeItem("__knitsailIoPersist"); } catch {} })()`,
            Math.min(2000, budget.remaining()),
        );
        await client.send("Page.navigate", { url }, sessionId);

        let live = null;
        let seenSei = false;
        while (budget.remaining() > 500) {
            await new Promise((r) => setTimeout(r, 300));
            const ev = await evaluateWithTimeout(client, sessionId, READ, Math.min(3000, budget.remaining()));
            live = ev.value ?? null;
            if (live?.currentHop === "sei" || live?.callsByHop?.sei > 0) seenSei = true;
            const docSearchHops = hops.filter((h) => h.url?.includes("/search")).length;
            const hasSgReplace = live?.io?.replaces?.some((r) => r.sg_ss);
            const serpTitle = live?.title && !live.title.startsWith("http") && live.title.includes("Google Search");

            if (seenSei && (live?.callCount > 0 || serpTitle || live?.currentHop === "sorry")) {
                if (budget.remaining() < 4000 || hasSgReplace || serpTitle) break;
            }
            if (hasSgReplace && live?.callCount > 0) break;
            const last = hops.at(-1)?.url || "";
            if (last.includes("/sorry")) break;
            if (docSearchHops >= 3) break;
            if (seenSei && docSearchHops >= 2 && budget.remaining() < 6000) break;
        }
        if (!live?.callCount) {
            const ev = await evaluateWithTimeout(client, sessionId, READ, Math.min(3000, budget.remaining()));
            live = ev.value ?? live;
        }
        return { label, url, hops, ...live };
    } finally {
        client.close();
    }
}

function printHopSummary(hop, hs) {
    if (!hs.callCount && !hs.encoded && !hs.sgCookie) return;
    console.log(`  [${hop}] calls=${hs.callCount} sn=${hs.sn ?? "null"} pageT=${hs.pageT ?? "-"}`);
    if (hs.encoded) {
        console.log(`    encoded: len=${hs.encoded.len} head=${JSON.stringify(hs.encoded.head)}`);
    }
    if (hs.sgCookie) console.log(`    SG_SS cookie: len=${hs.sgCookie.len}`);
    if (hs.arg2 || hs.arg7) {
        console.log(`    arg2=${JSON.stringify(hs.arg2?.value ?? null)} arg7=${JSON.stringify(hs.arg7?.value ?? null)}`);
    }
}

function printEngine(label, sum) {
    console.log(`\n=== ${label} ===`);
    console.log(`knitsail.a calls: ${sum.callCount} by hop: ${JSON.stringify(sum.callsByHop)}`);
    console.log(`doc hops: ${(sum.docHops || []).map((d) => d.hop).join(" → ") || "-"}`);
    for (const hop of ["initial", "sei", "sg_ss"]) printHopSummary(hop, sum.hopSummaries[hop]);
    console.log(`location.replace: ${sum.replaceCount} by hop: ${JSON.stringify(sum.replacesByHop)}`);
    if (sum.replaceSg) console.log(`  sg_ss token: len=${sum.replaceSg.len} star=${sum.replaceSg.hasStar}`);
    console.log(`SG_SS cookie writes: ${sum.cookieWrites}`);
    if (sum.beacons?.length) console.log(`beacons: ${sum.beacons.map((b) => b.cad + (b.err ? "=" + b.err : "")).join(", ")}`);
    console.log(`current hop: ${sum.currentHop} | final: ${sum.title || sum.finalHref || "-"}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const budget = createProbeBudget(args.maxSec, ({ signal }) => {
        killProc(veloraProc, signal);
        killProc(chromeProc, signal);
    });

    let veloraProc = null;
    let chromeProc = null;
    const targetUrl = buildSearchUrl(args.query, { hl: "en" });
    const results = {};

    try {
        if (args.engines.includes("velora")) {
            const port = await getFreePort();
            const launch = await spawnVelora(args.profile, port);
            veloraProc = launch.proc;
            console.log(`[velora] ${targetUrl}`);
            results.velora = await capture({
                endpoint: launch.endpoint,
                url: targetUrl,
                label: "velora",
                budget,
            });
        }

        if (args.engines.includes("chrome")) {
            const chromeSession = await resolveGoogleChromeSession({
                profileDir: `/tmp/velora-knitsail-io-chrome-${Date.now()}`,
            });
            chromeProc = chromeSession.proc;
            console.log(`[chrome] ${targetUrl}`);
            results.chrome = await capture({
                endpoint: chromeSession.endpoint,
                url: targetUrl,
                label: "chrome",
                budget,
            });
        }

        const comparison = results.velora && results.chrome
            ? diffEngines(results.velora, results.chrome)
            : null;

        const outDir = resolve(REPO, `google-search-debug/tmp/probe-knitsail-io-${Date.now()}`);
        await mkdir(outDir, { recursive: true });
        const report = { url: targetUrl, results, comparison };
        await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));

        if (results.velora) printEngine("velora", summarizeEngine(results.velora));
        if (results.chrome) printEngine("chrome", summarizeEngine(results.chrome));

        if (comparison) {
            console.log("\n=== Velora vs Chrome I/O diff ===");
            if (!comparison.diffs.length) {
                console.log("(no differences in captured I/O)");
            } else {
                for (const d of comparison.diffs) {
                    console.log(`${d.field}: velora=${JSON.stringify(d.velora ?? d.lenA ?? d.a)} chrome=${JSON.stringify(d.chrome ?? d.lenB ?? d.b)}`);
                    if (d.ctxA) console.log(`  firstDiff@${d.index}: v=${JSON.stringify(d.ctxA)} c=${JSON.stringify(d.ctxB)}`);
                }
            }
        }

        console.log(`\nsaved: ${outDir}/report.json`);
    } finally {
        budget.clear();
        killProc(veloraProc);
        killProc(chromeProc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });