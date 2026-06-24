#!/usr/bin/env node
// Hook SG_SS + window.sgs: cookie setter, sgs promise, beacons, network Set-Cookie.
// Usage: node code-check/sites/google/hook-sgss.mjs [--chrome]
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const OUT = resolve(repoRoot, "code-check/tmp/google-sgss-hook");
const SEARCH = "https://www.google.com/search?q=sgssprobe&hl=en";
const useChrome = process.argv.includes("--chrome");

const PROBE_HOOK = `(() => {
    const root = window.top;
    const store = root.__sgssHook || (root.__sgssHook = {
        cookieSets: [],
        polls: [],
        nav: [],
        errors: [],
        sgsCalls: [],
        beacons: [],
        ticks: [],
        globalSnaps: [],
        sgsWrapped: false,
        sgsPolls: 0,
        sgsTrapInstalled: false,
        tickHooked: false,
    });

    const logNav = (kind, detail) => {
        if (store.nav.length < 100) store.nav.push({ t: performance.now(), kind, detail, href: location.href.slice(0, 120) });
    };

    const logCookie = (via, value, stack) => {
        const v = String(value || "");
        if (!v.includes("SG_SS")) return;
        store.cookieSets.push({
            t: performance.now(),
            via,
            href: location.href.slice(0, 120),
            valueLen: v.length,
            prefix: v.slice(0, 48),
            stack: (stack || new Error("sgss").stack || "").split("\\n").slice(0, 12),
        });
    };

    try {
        const proto = Document.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "cookie");
        if (desc && desc.set) {
            const origSet = desc.set;
            desc.set = function (v) {
                logCookie("document.cookie", v);
                return origSet.call(this, v);
            };
            Object.defineProperty(proto, "cookie", desc);
        } else {
            store.errors.push("no cookie descriptor");
        }
    } catch (e) {
        store.errors.push("cookie hook: " + String(e));
    }

    const origAssign = Location.prototype.assign;
    Location.prototype.assign = function (url) {
        logNav("assign", String(url).slice(0, 120));
        return origAssign.call(this, url);
    };
    const origReplace = Location.prototype.replace;
    Location.prototype.replace = function (url) {
        logNav("replace", String(url).slice(0, 120));
        return origReplace.call(this, url);
    };

    let last = "";
    const poll = () => {
        try {
            const c = document.cookie || "";
            const has = c.includes("SG_SS=");
            if (has && c !== last) {
                const m = c.match(/SG_SS=([^;]+)/);
                store.polls.push({
                    t: performance.now(),
                    href: location.href.slice(0, 120),
                    len: m ? m[1].length : 0,
                    prefix: m ? m[1].slice(0, 32) : null,
                    docCookieLen: c.length,
                });
                last = c;
            }
        } catch (e) {}
        if (store.polls.length < 20) setTimeout(poll, 25);
    };
    poll();

    const snapGlobals = (tag) => {
        try {
            store.globalSnaps.push({
                t: performance.now(),
                tag,
                href: location.href.slice(0, 120),
                hasSgs: typeof window.sgs,
                hasSp: typeof sp !== "undefined",
                hasUssv: typeof ussv !== "undefined",
                ussv: typeof ussv !== "undefined" ? ussv : null,
                spLen: typeof sp !== "undefined" ? String(sp).length : 0,
                spPreview: typeof sp !== "undefined" ? String(sp).slice(0, 120) : null,
                challenge_version: typeof challenge_version !== "undefined" ? challenge_version : null,
                cbs: typeof cbs !== "undefined" ? String(cbs).slice(0, 120) : null,
                enablejs: document.documentElement?.innerHTML?.includes("enablejs") ?? false,
                searchResults: document.documentElement?.innerHTML?.includes("SearchResultsPage") ?? false,
                htmlLen: document.documentElement?.outerHTML?.length ?? 0,
            });
        } catch (e) {
            store.errors.push("globals " + tag + ": " + String(e));
        }
    };

    const wrapSgsFn = (fn) => {
        return function (...args) {
            store.sgsCalls.push({
                t: performance.now(),
                phase: "call",
                argLen: args.length,
                arg0: args[0] != null ? String(args[0]).slice(0, 120) : null,
            });
            let p;
            try {
                p = fn.apply(this, args);
            } catch (e) {
                store.sgsCalls.push({
                    t: performance.now(),
                    phase: "throw",
                    error: String(e),
                    name: e?.name,
                    message: e?.message,
                });
                throw e;
            }
            if (!p || typeof p.then !== "function") {
                store.sgsCalls.push({ t: performance.now(), phase: "not-promise", typeofP: typeof p });
                return p;
            }
            return p.then(
                (r) => {
                    store.sgsCalls.push({
                        t: performance.now(),
                        phase: "resolve",
                        resultType: typeof r,
                        result: r != null ? String(r).slice(0, 200) : null,
                    });
                    return r;
                },
                (e) => {
                    store.sgsCalls.push({
                        t: performance.now(),
                        phase: "reject",
                        error: String(e),
                        name: e?.name,
                        message: e?.message,
                        stack: (e?.stack || "").split("\\n").slice(0, 8),
                    });
                    throw e;
                },
            );
        };
    };

    const installSgsTrap = () => {
        if (store.sgsTrapInstalled) return;
        store.sgsTrapInstalled = true;
        let inner = undefined;
        try {
            Object.defineProperty(window, "sgs", {
                get() { return inner; },
                set(fn) {
                    store.sgsCalls.push({
                        t: performance.now(),
                        phase: "assigned",
                        typeofFn: typeof fn,
                    });
                    if (typeof fn !== "function") {
                        inner = fn;
                        return;
                    }
                    inner = wrapSgsFn(fn);
                    store.sgsWrapped = true;
                    snapGlobals("sgs-assigned");
                },
                configurable: true,
                enumerable: true,
            });
        } catch (e) {
            store.errors.push("sgs trap: " + String(e));
        }
    };
    installSgsTrap();

    const wrapSgs = () => {
        if (store.sgsWrapped) return;
        const fn = window.sgs;
        if (typeof fn !== "function") return;
        store.sgsWrapped = true;
        snapGlobals("pre-sgs-call");
        window.sgs = wrapSgsFn(fn);
        store.sgsCalls.push({ t: performance.now(), phase: "wrapped-fallback" });
    };

    const pollSgs = () => {
        wrapSgs();
        if (store.sgsPolls === 0 || store.sgsPolls % 20 === 0) snapGlobals("poll-" + store.sgsPolls);
        store.sgsPolls += 1;
        if (!store.sgsWrapped && store.sgsPolls < 400) setTimeout(pollSgs, 5);
    };
    pollSgs();

    try {
        const beacon = navigator.sendBeacon?.bind(navigator);
        if (beacon) {
            navigator.sendBeacon = function (url, data) {
                const u = String(url || "");
                if (u.includes("gen_204") || u.includes("jserror") || u.includes("httpservice")) {
                    store.beacons.push({
                        t: performance.now(),
                        url: u.slice(0, 240),
                        data: data != null ? String(data).slice(0, 240) : null,
                        href: location.href.slice(0, 120),
                    });
                }
                return beacon(url, data);
            };
        }
    } catch (e) {
        store.errors.push("beacon hook: " + String(e));
    }

    const hookGoogleTick = () => {
        try {
            if (store.tickHooked || !window.google?.tick) return;
            store.tickHooked = true;
            const orig = window.google.tick.bind(window.google);
            window.google.tick = function (a, b) {
                if (a === "load" && typeof b === "string") {
                    store.ticks.push({ t: performance.now(), mark: b, href: location.href.slice(0, 120) });
                }
                return orig(a, b);
            };
        } catch (e) {
            store.errors.push("tick hook: " + String(e));
        }
    };
    const tickPoll = () => {
        hookGoogleTick();
        if (!store.tickHooked) setTimeout(tickPoll, 1);
    };
    tickPoll();

    document.addEventListener("DOMContentLoaded", () => snapGlobals("domcontentloaded"), { once: true });
    window.addEventListener("load", () => snapGlobals("load"), { once: true });
    snapGlobals("doc-init");
})()`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseSetCookie(raw) {
    const s = String(raw || "");
    if (!s) return [];
    return s.split(/,(?=[^;]+?=)/).map((part) => {
        const name = part.trim().split("=")[0];
        return { name, isSgSs: name === "SG_SS" };
    });
}

async function getFreePort() {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.unref();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
    });
}

async function runCapture(label, setup) {
    const network = [];
    const docs = [];
    const jarSnapshots = [];
    const frameSnaps = [];
    const { page, session, cleanup } = await setup();

    const onFrameNavigated = async () => {
        try {
            const snap = await page.evaluate(`(() => {
                const s = (window.top && window.top.__sgssHook) || window.__sgssHook || {};
                const g = (s.globalSnaps || []).slice(-1)[0] || null;
                return {
                    url: location.href.slice(0, 200),
                    sgsCallCount: (s.sgsCalls || []).length,
                    lastSgs: (s.sgsCalls || []).slice(-4),
                    lastGlobals: g,
                    ticks: (s.ticks || []).slice(-12),
                    beacons: (s.beacons || []).slice(-6),
                };
            })()`);
            frameSnaps.push({ t: Date.now(), ...snap });
        } catch {}
    };
    if (typeof page.on === "function") {
        page.on("framenavigated", onFrameNavigated);
    } else {
        await session.send("Page.enable");
        session.on("Page.frameNavigated", onFrameNavigated);
    }

    await session.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE_HOOK });
    await session.send("Network.enable");

    const snapshotJar = async (tag, url) => {
        try {
            const { cookies } = await session.send("Network.getAllCookies");
            const names = cookies.map((c) => c.name).sort();
            jarSnapshots.push({
                t: Date.now(),
                tag,
                url: url.slice(0, 200),
                names,
                hasSgSs: names.includes("SG_SS"),
                sgssLen: cookies.find((c) => c.name === "SG_SS")?.value?.length ?? 0,
            });
        } catch (e) {
            jarSnapshots.push({ t: Date.now(), tag, url, error: String(e) });
        }
    };

    session.on("Network.requestWillBeSent", async (p) => {
        if (p.type !== "Document") return;
        const url = p.request?.url || "";
        if (!url.includes("google.com")) return;
        const cookie = p.request?.headers?.Cookie ?? p.request?.headers?.cookie ?? "";
        const tag = url.includes("sei=") ? "doc-sei-req" : "doc-hop1-req";
        await snapshotJar(tag, url);
        docs.push({
            t: Date.now(),
            url: url.slice(0, 200),
            hasSei: url.includes("sei="),
            cookieLen: String(cookie).length,
            hasSgSsInReq: String(cookie).includes("SG_SS"),
        });
    });

    session.on("Network.responseReceived", async (p) => {
        const url = p.response?.url || "";
        const sc = p.response?.headers?.["set-cookie"]
            ?? p.response?.headers?.["Set-Cookie"]
            ?? "";
        const cookies = parseSetCookie(sc);
        const entry = {
            t: Date.now(),
            type: p.type,
            status: p.response?.status,
            url: url.slice(0, 200),
            setCookies: cookies.map((c) => c.name),
            setCookieRawLen: String(sc).length,
            hasSgSs: cookies.some((c) => c.isSgSs) || String(sc).includes("SG_SS"),
        };
        network.push(entry);
        if (entry.hasSgSs) {
            await snapshotJar(`set-cookie-sgss:${p.type}:${p.response?.status}`, url);
        }
        if (p.type === "Document" && url.includes("google.com/search") && p.response?.status === 200) {
            await snapshotJar(`doc-200:${url.includes("sei=") ? "sei" : "hop1"}`, url);
        }
    });

    let page1Html = null;
    session.on("Network.responseReceived", async (p) => {
        const url = p.response?.url || "";
        if (url !== SEARCH && !url.startsWith(SEARCH + "&")) return;
        if (p.response?.status !== 200 || page1Html) return;
        try {
            const body = await session.send("Network.getResponseBody", { requestId: p.requestId });
            const raw = body.body || "";
            page1Html = body.base64Encoded
                ? Buffer.from(raw, "base64").toString("utf8").slice(0, 300000)
                : raw.slice(0, 300000);
        } catch {}
    });

    await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await delay(500);
    try {
        frameSnaps.push({
            t: Date.now(),
            tag: "post-goto-500ms",
            ...(await page.evaluate(`(() => {
                const s = (window.top && window.top.__sgssHook) || window.__sgssHook || {};
                return {
                    url: location.href.slice(0, 200),
                    sgsCallCount: (s.sgsCalls || []).length,
                    lastSgs: (s.sgsCalls || []).slice(-6),
                    globalSnaps: (s.globalSnaps || []).slice(-4),
                    ticks: (s.ticks || []).slice(-12),
                    beacons: (s.beacons || []).slice(-6),
                };
            })()`)),
        });
    } catch {}
    await delay(1500);

    const hook = await page.evaluate(`(() => {
        const s = (window.top && window.top.__sgssHook) || window.__sgssHook || {};
        const globals = {
            hasSgs: typeof window.sgs,
            hasSp: typeof sp !== "undefined",
            hasUssv: typeof ussv !== "undefined",
            ussv: typeof ussv !== "undefined" ? ussv : null,
            spLen: typeof sp !== "undefined" ? String(sp).length : 0,
            spPreview: typeof sp !== "undefined" ? String(sp).slice(0, 120) : null,
            challenge_version: typeof challenge_version !== "undefined" ? challenge_version : null,
            cbs: typeof cbs !== "undefined" ? String(cbs).slice(0, 120) : null,
        };
        return {
            cookieSets: s.cookieSets || [],
            polls: s.polls || [],
            nav: s.nav || [],
            errors: s.errors || [],
            sgsCalls: s.sgsCalls || [],
            beacons: s.beacons || [],
            ticks: s.ticks || [],
            globalSnaps: s.globalSnaps || [],
            globals,
            pageKind: {
                enablejs: document.documentElement.innerHTML.includes("enablejs"),
                searchResults: document.documentElement.innerHTML.includes("SearchResultsPage"),
                htmlLen: document.documentElement.outerHTML.length,
            },
            docCookie: document.cookie,
            hasSgSs: document.cookie.includes("SG_SS="),
            url: location.href,
            sorry: location.href.includes("/sorry"),
        };
    })()`);

    const htmlHints = page1Html ? {
        len: page1Html.length,
        sgssLiteral: (page1Html.match(/SG_SS/g) || []).length,
        sgssAssign: (page1Html.match(/SG_SS\\s*=/g) || []).length,
        hasSgssSetCookie: /Set-Cookie[^\\n]*SG_SS/i.test(page1Html),
        scriptCount: (page1Html.match(/<script/gi) || []).length,
        hasWindowSgs: /window\.sgs/.test(page1Html),
        hasEnablejs: /enablejs/.test(page1Html),
        hasSearchResults: /SearchResultsPage/.test(page1Html),
        snippet: (() => {
            const idx = page1Html.indexOf("window.sgs");
            if (idx >= 0) return page1Html.slice(Math.max(0, idx - 40), idx + 200);
            const idx2 = page1Html.indexOf("SG_SS");
            return idx2 >= 0 ? page1Html.slice(Math.max(0, idx2 - 80), idx2 + 120) : null;
        })(),
    } : null;

    await cleanup();

    return { label, hook, network, docs, jarSnapshots, frameSnaps, htmlHints, page1Html };
}

async function runVelora() {
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-sonoma", "--log-level", "warn",
    ], { cwd: repoRoot, stdio: "ignore" });
    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i++) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {}
        await delay(100);
    }
    try {
        return await runCapture("velora", async () => {
            const b = await Browser.connect(endpoint);
            const page = await b.newPage();
            return { page, session: page.session, cleanup: () => b.close() };
        });
    } finally {
        proc.kill("SIGTERM");
    }
}

async function runChrome() {
    const browser = await chromium.launch({
        channel: "chrome",
        headless: false,
        args: ["--incognito", "--disable-blink-features=AutomationControlled"],
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    return runCapture("chrome", async () => ({
        page,
        session,
        cleanup: () => browser.close(),
    }));
}

async function main() {
    if (!useChrome && !existsSync(veloraBin)) throw new Error("zig build first");
    mkdirSync(OUT, { recursive: true });

    const results = [];
    if (useChrome) {
        console.log("[capture] Chrome incognito...");
        results.push(await runChrome());
    } else {
        console.log("[capture] Velora...");
        results.push(await runVelora());
        console.log("[capture] Chrome incognito (reference)...");
        results.push(await runChrome());
    }

    const report = { search: SEARCH, results };
    writeFileSync(resolve(OUT, "sgss-hook.json"), JSON.stringify(report, null, 2));
    for (const r of results) {
        if (r.page1Html) {
            writeFileSync(resolve(OUT, `${r.label}-page1.html`), r.page1Html);
        }
    }

    for (const r of results) {
        const h = r.hook;
        console.log(`\n=== ${r.label} ===`);
        console.log(`final: ${h.url.slice(0, 100)}`);
        console.log(`sorry: ${h.sorry} docCookie SG_SS: ${h.hasSgSs}`);
        console.log(`cookie setter hooks: ${h.cookieSets.length}`);
        console.log(`poll detections: ${h.polls.length}`);
        console.log(`nav hooks: ${h.nav.length}`);
        if (h.errors.length) console.log(`errors: ${h.errors.join("; ")}`);

        const sgssNet = r.network.filter((n) => n.hasSgSs);
        console.log(`network Set-Cookie SG_SS: ${sgssNet.length}`);
        for (const n of sgssNet.slice(0, 5)) {
            console.log(`  ${n.status} ${n.type} ${n.url.slice(0, 90)}`);
        }

        for (const d of r.docs) {
            console.log(`  doc ${d.hasSei ? "sei" : "hop1"} cookie=${d.cookieLen} sgss=${d.hasSgSsInReq} ${d.url.slice(0, 70)}`);
        }

        console.log("jar snapshots:");
        for (const s of r.jarSnapshots) {
            console.log(`  [${s.tag}] sgss=${s.hasSgSs} names=${(s.names || []).join(",") || s.error || ""}`);
        }

        const pk = h.pageKind || {};
        console.log(`page kind: enablejs=${pk.enablejs} searchResults=${pk.searchResults} htmlLen=${pk.htmlLen}`);
        console.log(`sgs globals: sgs=${h.globals?.hasSgs} sp=${h.globals?.hasSp} ussv=${h.globals?.hasUssv} cv=${h.globals?.challenge_version}`);
        if (h.globals?.spPreview) console.log(`  sp: ${h.globals.spPreview.slice(0, 100)}`);
        if (h.sgsCalls?.length) {
            console.log(`sgs calls (${h.sgsCalls.length}):`);
            for (const c of h.sgsCalls.slice(0, 8)) {
                const extra = c.phase === "reject" || c.phase === "throw"
                    ? ` ${c.name || ""}: ${c.message || c.error || ""}`
                    : c.result != null ? ` → ${String(c.result).slice(0, 80)}` : "";
                console.log(`  [${c.phase}] @${(c.t || 0).toFixed?.(1) ?? c.t}${extra}`);
            }
        } else {
            console.log("sgs calls: 0 (window.sgs never wrapped/invoked)");
        }
        if (h.ticks?.length) {
            console.log(`google.tick load: ${h.ticks.map((t) => t.mark).join(" → ")}`);
        }
        if (h.beacons?.length) {
            console.log(`beacons (${h.beacons.length}):`);
            for (const b of h.beacons.slice(0, 5)) {
                console.log(`  ${b.url.replace(/\?.*/, "").slice(-60)} @${(b.t || 0).toFixed?.(1) ?? b.t}`);
            }
        }

        const hop1Snap = (h.globalSnaps || []).find((g) => g.tag === "doc-init" && g.href?.includes("/search?"));
        if (hop1Snap) {
            console.log(`hop1 globals @init: sgs=${hop1Snap.hasSgs} sp=${hop1Snap.hasSp} ussv=${hop1Snap.hasUssv} enablejs=${hop1Snap.enablejs}`);
        }
        if (r.frameSnaps?.length) {
            console.log(`frame snaps (${r.frameSnaps.length}):`);
            for (const f of r.frameSnaps.slice(0, 6)) {
                const g = f.lastGlobals || (f.globalSnaps || []).slice(-1)[0];
                const sgsN = f.sgsCallCount ?? (f.lastSgs || []).length;
                console.log(`  ${f.url?.slice(0, 75) || f.tag} sgsCalls=${sgsN}${g ? ` sp=${g.hasSp} ussv=${g.hasUssv}` : ""}`);
                for (const c of (f.lastSgs || []).slice(-3)) {
                    console.log(`    sgs [${c.phase}]${c.message || c.result ? ` ${c.message || c.result}` : ""}`);
                }
            }
        }

        if (r.htmlHints) {
            console.log(`page1 html: ${r.htmlHints.len} chars, SG_SS=${r.htmlHints.sgssLiteral}, scripts=${r.htmlHints.scriptCount}, sgs=${r.htmlHints.hasWindowSgs}, enablejs=${r.htmlHints.hasEnablejs}, SERP=${r.htmlHints.hasSearchResults}`);
            if (r.htmlHints.snippet) console.log(`  snippet: ${r.htmlHints.snippet.replace(/\s+/g, " ").slice(0, 200)}`);
        }

        const sgssResponses = r.network.filter((n) => n.hasSgSs);
        if (sgssResponses.length) {
            console.log("responses with SG_SS Set-Cookie:");
            for (const n of sgssResponses) {
                console.log(`  ${n.status} ${n.type} ${n.url.slice(0, 90)} rawLen=${n.setCookieRawLen}`);
            }
        }

        for (const c of h.cookieSets.slice(0, 3)) {
            console.log(`  cookie set @${c.t.toFixed(1)}ms via ${c.via} len=${c.valueLen}`);
            for (const line of c.stack.slice(0, 4)) console.log(`    ${line.trim()}`);
        }
        for (const p of h.polls.slice(0, 3)) {
            console.log(`  poll @${p.t.toFixed(1)}ms len=${p.len} href=${p.href.slice(0, 60)}`);
        }
        for (const n of h.nav.filter((x) => x.detail?.includes("sei=")).slice(0, 3)) {
            console.log(`  nav ${n.kind} @${n.t.toFixed(1)}ms → ${n.detail.slice(0, 80)}`);
        }
    }

    console.log(`\nsaved: ${OUT}/sgss-hook.json`);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});