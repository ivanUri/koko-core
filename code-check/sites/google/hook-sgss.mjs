#!/usr/bin/env node
// Hook SG_SS + window.sgs; compare Chrome guest vs Velora on the same query.
//
// Usage (real Chrome via CDP — no Playwright):
//   /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222
//   node code-check/sites/google/hook-sgss.mjs
//   CHROME_CDP=http://127.0.0.1:9222 node hook-sgss.mjs --only chrome
//   VELORA_ENDPOINT=http://127.0.0.1:19500 node hook-sgss.mjs --only velora
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";
import { connectChrome } from "./lib/chrome-cdp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const OUT = resolve(repoRoot, "code-check/tmp/google-sgss-hook");

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = {
        only: "both",
        query: `sgssprobe-${Date.now()}`,
        cooldownMs: 35_000,
        endpoint: process.env.VELORA_ENDPOINT || null,
        spawnChrome: false,
        chromeEndpoint: undefined,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
            i += 1;
            return argv[i];
        };
        switch (a) {
            case "--only": out.only = next(); break;
            case "--query": out.query = next(); break;
            case "--cooldown": out.cooldownMs = Number(next()); break;
            case "--endpoint": out.endpoint = next(); break;
            case "--spawn-chrome": out.spawnChrome = true; break;
            case "--chrome-endpoint": out.chromeEndpoint = next(); break;
            case "--chrome": out.only = "chrome"; break;
            case "--velora": out.only = "velora"; break;
            case "--help":
                console.log(`Usage: node hook-sgss.mjs [--only chrome|velora|both] [--query Q] [--cooldown MS] [--endpoint URL]`);
                process.exit(0);
            default:
                throw new Error(`Unknown arg: ${a}`);
        }
    }
    return out;
}

function searchUrl(query) {
    return `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
}

function hopKind(url) {
    if (url.includes("/sorry")) return "sorry";
    if (url.includes("sg_ss=")) return "sg_ss";
    if (url.includes("sei=")) return "sei";
    if (url.includes("google.com/search")) return "search";
    return "other";
}

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

function parseSetCookie(raw) {
    const s = String(raw || "");
    if (!s) return [];
    return s.split(/,(?=[^;]+?=)/).map((part) => {
        const name = part.trim().split("=")[0];
        return { name, isSgSs: name === "SG_SS" };
    });
}

function hdr(headers, key) {
    if (!headers) return null;
    const want = key.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === want) return v;
    }
    return null;
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

async function runCapture(label, search, setup) {
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
        const kind = hopKind(url);
        const tag = kind === "sei" ? "doc-sei-req" : kind === "sg_ss" ? "doc-sgss-req" : "doc-hop1-req";
        await snapshotJar(tag, url);
        docs.push({
            t: Date.now(),
            kind,
            url: url.slice(0, 200),
            cookieLen: String(cookie).length,
            hasSgSsInReq: String(cookie).includes("SG_SS"),
            headers: {
                referer: hdr(p.request?.headers, "referer"),
                "sec-fetch-site": hdr(p.request?.headers, "sec-fetch-site"),
                "sec-fetch-mode": hdr(p.request?.headers, "sec-fetch-mode"),
                "sec-fetch-dest": hdr(p.request?.headers, "sec-fetch-dest"),
                "sec-fetch-user": hdr(p.request?.headers, "sec-fetch-user"),
            },
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
            kind: hopKind(url),
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
            await snapshotJar(`doc-200:${entry.kind}`, url);
        }
    });

    let page1Html = null;
    const searchBase = search.split("?")[0];
    session.on("Network.responseReceived", async (p) => {
        const url = p.response?.url || "";
        if (!url.startsWith(searchBase) || !url.includes("q=")) return;
        if (hopKind(url) !== "search" || p.response?.status !== 200 || page1Html) return;
        try {
            const body = await session.send("Network.getResponseBody", { requestId: p.requestId });
            const raw = body.body || "";
            page1Html = body.base64Encoded
                ? Buffer.from(raw, "base64").toString("utf8").slice(0, 300000)
                : raw.slice(0, 300000);
        } catch {}
    });

    await page.goto(search, { waitUntil: "domcontentloaded", timeout: 90_000 });
    for (let i = 0; i < 120; i++) {
        try {
            const u = await page.evaluate(() => location.href);
            if (u.includes("sg_ss=") || u.includes("/sorry")) break;
            const html = await page.content().catch(() => "");
            if (/SearchResultsPage/.test(html)) break;
        } catch {}
        await delay(250);
    }
    await delay(2500);

    try {
        frameSnaps.push({
            t: Date.now(),
            tag: "post-settle",
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
        let ttEval = null;
        try {
            ttEval = eval(trustedTypes.createPolicy("x", { createScript: (x) => x }).createScript("1")) === 1;
        } catch (e) {
            ttEval = String(e);
        }
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
            ttEval,
            pageKind: {
                enablejs: document.documentElement.innerHTML.includes("enablejs"),
                searchResults: document.documentElement.innerHTML.includes("SearchResultsPage"),
                htmlLen: document.documentElement.outerHTML.length,
            },
            docCookie: document.cookie,
            hasSgSs: document.cookie.includes("SG_SS="),
            url: location.href,
            sorry: location.href.includes("/sorry"),
            serp: document.documentElement.innerHTML.includes("SearchResultsPage"),
        };
    })()`);

    const htmlHints = page1Html ? {
        len: page1Html.length,
        sgssLiteral: (page1Html.match(/SG_SS/g) || []).length,
        sgssAssign: (page1Html.match(/SG_SS\\s*=/g) || []).length,
        hasSgssSetCookie: /Set-Cookie[^\\n]*SG_SS/i.test(page1Html),
        scriptCount: (page1Html.match(/<script/gi) || []).length,
        hasWindowSgs: /window\\.sgs/.test(page1Html),
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

    return { label, search, hook, network, docs, jarSnapshots, frameSnaps, htmlHints, page1Html };
}

async function runVelora(search, endpoint) {
    let proc = null;
    let ep = endpoint;
    if (!ep) {
        if (!existsSync(veloraBin)) throw new Error("zig build first");
        const port = await getFreePort();
        proc = spawn(veloraBin, [
            "serve", "--host", "127.0.0.1", "--port", String(port),
            "--browser-profile", "chrome-macos-sonoma", "--log-level", "warn",
        ], {
            cwd: repoRoot,
            stdio: "ignore",
            env: { ...process.env, VELORA_ROOT: repoRoot },
        });
        ep = `http://127.0.0.1:${port}`;
        let ready = false;
        for (let i = 0; i < 60; i++) {
            try {
                if ((await fetch(`${ep}/json/version`)).ok) {
                    ready = true;
                    break;
                }
            } catch {}
            await delay(100);
        }
        if (!ready) {
            proc?.kill("SIGTERM");
            throw new Error(`Velora CDP not ready at ${ep} after 6s — restart velora serve manually`);
        }
    }
    try {
        return await runCapture("velora", search, async () => {
            const b = await Browser.connect(ep);
            const page = await b.newPage();
            return { page, session: page.session, cleanup: () => b.close() };
        });
    } finally {
        proc?.kill("SIGTERM");
    }
}

async function runChrome(search, chromeOpts) {
    const { browser } = await connectChrome(chromeOpts);
    const page = await browser.newPage();
    return runCapture("chrome", search, async () => ({
        page,
        session: page.session,
        cleanup: async () => {
            await page.close().catch(() => undefined);
        },
    }));
}

function summarizeResult(r) {
    const h = r.hook;
    const docHops = r.docs.map((d) => ({
        kind: d.kind,
        cookieLen: d.cookieLen,
        hasSgSsInReq: d.hasSgSsInReq,
        secFetchUser: d.headers?.["sec-fetch-user"] ?? null,
        referer: d.headers?.referer ? d.headers.referer.slice(0, 80) : null,
    }));
    const resHops = r.network
        .filter((n) => n.type === "Document" && (n.kind === "search" || n.kind === "sei" || n.kind === "sg_ss" || n.kind === "sorry"))
        .map((n) => ({ kind: n.kind, status: n.status, hasSgSs: n.hasSgSs }));
    const sgsPhases = (h.sgsCalls || []).map((c) => c.phase);
    return {
        label: r.label,
        outcome: h.sorry ? "sorry"
            : h.serp ? "SERP"
                : h.url.includes("sg_ss=") ? "sg_ss-no-serp"
                    : h.url.includes("sei=") ? "stalled-at-sei"
                        : "other",
        sorry: h.sorry,
        serp: h.serp,
        finalUrl: h.url.slice(0, 120),
        hasSgSsDoc: h.hasSgSs,
        ttEval: h.ttEval,
        sgsPhases,
        sgsResolved: sgsPhases.includes("resolve"),
        sgsRejected: sgsPhases.includes("reject"),
        cookieSets: h.cookieSets.length,
        docHops,
        resHops,
        globals: h.globals,
        hookErrors: h.errors,
        page1: r.htmlHints ? {
            hasWindowSgs: r.htmlHints.hasWindowSgs,
            enablejs: r.htmlHints.hasEnablejs,
            serp: r.htmlHints.hasSearchResults,
        } : null,
    };
}

function diffResults(chrome, velora) {
    const c = summarizeResult(chrome);
    const v = summarizeResult(velora);
    const rows = [];

    const cmp = (key, a, b) => {
        if (JSON.stringify(a) !== JSON.stringify(b)) rows.push({ key, chrome: a, velora: b });
    };

    cmp("outcome", c.outcome, v.outcome);
    cmp("ttEval", c.ttEval, v.ttEval);
    cmp("sgsResolved", c.sgsResolved, v.sgsResolved);
    cmp("sgsRejected", c.sgsRejected, v.sgsRejected);
    cmp("hasSgSsDoc", c.hasSgSsDoc, v.hasSgSsDoc);
    cmp("cookieSets", c.cookieSets, v.cookieSets);
    cmp("docHopCount", c.docHops.length, v.docHops.length);
    cmp("docHopKinds", c.docHops.map((h) => h.kind), v.docHops.map((h) => h.kind));
    cmp("resHopStatuses", c.resHops.map((h) => `${h.kind}:${h.status}`), v.resHops.map((h) => `${h.kind}:${h.status}`));

    const max = Math.max(c.docHops.length, v.docHops.length);
    for (let i = 0; i < max; i += 1) {
        const ch = c.docHops[i];
        const vh = v.docHops[i];
        if (!ch || !vh) {
            rows.push({ key: `docHop[${i}]`, chrome: ch ?? "(missing)", velora: vh ?? "(missing)" });
            continue;
        }
        if (ch.kind !== vh.kind) rows.push({ key: `docHop[${i}].kind`, chrome: ch.kind, velora: vh.kind });
        if (ch.cookieLen !== vh.cookieLen) rows.push({ key: `docHop[${i}].cookieLen`, chrome: ch.cookieLen, velora: vh.cookieLen });
        if (ch.hasSgSsInReq !== vh.hasSgSsInReq) rows.push({ key: `docHop[${i}].sgssInReq`, chrome: ch.hasSgSsInReq, velora: vh.hasSgSsInReq });
        if (ch.secFetchUser !== vh.secFetchUser) rows.push({ key: `docHop[${i}].secFetchUser`, chrome: ch.secFetchUser, velora: vh.secFetchUser });
    }

    if (JSON.stringify(c.sgsPhases) !== JSON.stringify(v.sgsPhases)) {
        rows.push({ key: "sgsPhases", chrome: c.sgsPhases, velora: v.sgsPhases });
    }
    if (JSON.stringify(c.globals) !== JSON.stringify(v.globals)) {
        rows.push({ key: "globals", chrome: c.globals, velora: v.globals });
    }
    if (JSON.stringify(c.page1) !== JSON.stringify(v.page1)) {
        rows.push({ key: "page1", chrome: c.page1, velora: v.page1 });
    }

    return { chrome: c, velora: v, diffs: rows };
}

function printSummary(r) {
    const s = summarizeResult(r);
    const h = r.hook;
    console.log(`\n=== ${r.label} ===`);
    console.log(`outcome: ${s.outcome}`);
    console.log(`final:   ${s.finalUrl}`);
    console.log(`ttEval:  ${s.ttEval}`);
    console.log(`SG_SS:   docCookie=${s.hasSgSsDoc} setterHooks=${s.cookieSets}`);
    console.log(`sgs:     phases=${s.sgsPhases.join(" → ") || "(none)"}`);
    if (h.errors?.length) console.log(`errors:  ${h.errors.join("; ")}`);

    console.log("doc req hops:");
    for (const d of s.docHops) {
        console.log(`  ${d.kind.padEnd(6)} cookie=${String(d.cookieLen).padStart(3)} sgssInReq=${d.hasSgSsInReq} secFetchUser=${d.secFetchUser ?? "(absent)"}`);
    }
    console.log("doc res hops:");
    for (const n of s.resHops) {
        console.log(`  ${n.kind.padEnd(6)} status=${n.status} setSgSs=${n.hasSgSs}`);
    }
    if (s.page1) {
        console.log(`page1:   sgs=${s.page1.hasWindowSgs} enablejs=${s.page1.enablejs} serp=${s.page1.serp}`);
    }
}

function printDiff(diff) {
    console.log("\n=== Chrome vs Velora diff ===");
    if (!diff.diffs.length) {
        console.log("(no differences — unexpected if Velora is blocked)");
        return;
    }
    for (const d of diff.diffs) {
        console.log(`\n[${d.key}]`);
        console.log(`  chrome: ${fmt(d.chrome)}`);
        console.log(`  velora: ${fmt(d.velora)}`);
    }
}

function fmt(v) {
    if (v == null) return String(v);
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    const search = searchUrl(opts.query);
    mkdirSync(OUT, { recursive: true });

    console.log(`query: ${opts.query}`);
    console.log(`search: ${search}`);

    const results = [];

    if (opts.only === "chrome" || opts.only === "both") {
        console.log("\n[capture] Real Chrome (CDP)...");
        results.push(await runChrome(search, { spawn: opts.spawnChrome, endpoint: opts.chromeEndpoint }));
    }

    if (opts.only === "both") {
        console.log(`\n[cooldown] ${opts.cooldownMs}ms before Velora...`);
        await delay(opts.cooldownMs);
    }

    if (opts.only === "velora" || opts.only === "both") {
        console.log("\n[capture] Velora...");
        results.push(await runVelora(search, opts.endpoint));
    }

    const report = { query: opts.query, search, results };
    if (results.length === 2) {
        report.diff = diffResults(results[0], results[1]);
    }
    writeFileSync(resolve(OUT, "sgss-hook.json"), JSON.stringify(report, null, 2));
    for (const r of results) {
        if (r.page1Html) {
            writeFileSync(resolve(OUT, `${r.label}-page1.html`), r.page1Html);
        }
    }

    for (const r of results) printSummary(r);
    if (report.diff) printDiff(report.diff);

    console.log(`\nsaved: ${OUT}/sgss-hook.json`);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});