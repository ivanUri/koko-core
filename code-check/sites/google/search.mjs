#!/usr/bin/env node
// Google Search end-to-end test via Velora SDK + antidetect profile.
//
// Flows:
//   homepage (default) — google.com → consent → click search box → type → Enter
//   warm               — homepage dwell + scroll → search (Velora-owned cookie-jar)
//   direct             — GET /search?q=...
//
// Usage:
//   npm run test:site:google
//   node code-check/sites/google/search.mjs --profile chrome-macos-sonoma --query "velora browser"
//   node code-check/sites/google/search.mjs --profile chrome-windows-11 --mode direct
//   node code-check/sites/google/search.mjs --cookie ./google-cookies.json --cookie-jar ./google-session.json
//
// Exit codes:
//   0  SERP OK (organic results visible)
//   1  Engine OK but blocked (/sorry) or empty SERP
//   2  Engine broken (could not reach Google)

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");

const DEFAULT_PROFILE = "chrome-macos-sonoma";
const GOOGLE_HOME = "https://www.google.com/?hl=en";

function searchUrl(query) {
    return `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;
}

function parseArgs(argv) {
    const out = {
        endpoint: process.env.VELORA_CDP || null,
        query: "velora browser",
        profile: DEFAULT_PROFILE,
        profilePool: null,
        mode: "homepage",
        input: "dom",
        cookie: null,
        cookieJar: null,
        output: resolve(repoRoot, "code-check/tmp/google-search"),
        timeout: 90_000,
        settleMs: 2500,
        warmDwellMs: 4000,
        warmScrolls: 3,
        warmFocusMs: 1200,
        chromeTransport: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
            i += 1;
            return argv[i];
        };
        switch (a) {
            case "--endpoint": out.endpoint = next(); break;
            case "--query": out.query = next(); break;
            case "--profile": out.profile = next(); break;
            case "--profile-pool": out.profilePool = next(); break;
            case "--mode": out.mode = next(); break;
            case "--input": out.input = next(); break;
            case "--cookie": out.cookie = resolve(next()); break;
            case "--cookie-jar": out.cookieJar = resolve(next()); break;
            case "--output": out.output = resolve(next()); break;
            case "--timeout": out.timeout = Number(next()); break;
            case "--settle": out.settleMs = Number(next()); break;
            case "--warm-dwell": out.warmDwellMs = Number(next()); break;
            case "--warm-scrolls": out.warmScrolls = Number(next()); break;
            case "--chrome-transport": out.chromeTransport = true; break;
            case "--help":
                console.log(`Usage: node search.mjs [options]

Options:
  --profile <name>        Browser profile (default: ${DEFAULT_PROFILE})
  --profile-pool <list>   Comma-separated pool (velora --browser-profile-pool)
  --mode homepage|warm|direct  Search flow (default: homepage)
  --input dom|cdp         Homepage typing: DOM events or CDP Input (default: dom)
  --query <text>          Search query
  --cookie <path>         Load cookies at startup (Velora session only)
  --cookie-jar <path>     Save cookies + localStorage on exit (Velora-owned session)
  --endpoint <cdp-url>    Use existing Velora CDP
  --output <dir>          Report directory
  --timeout <ms>          Navigation timeout
  --settle <ms>           Post-navigation settle time
  --warm-dwell <ms>       Warm mode: dwell on homepage (default: 4000)
  --warm-scrolls <n>      Warm mode: scroll passes (default: 3)
  --chrome-transport      Route google.com/search docs via real Chrome (SERP)
`);
                process.exit(0);
                break;
            default:
                if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
        }
    }
    if (!["homepage", "warm", "direct"].includes(out.mode)) {
        throw new Error("--mode must be homepage, warm, or direct");
    }
    if (out.mode === "warm" && !out.cookieJar) {
        out.cookieJar = resolve(repoRoot, "code-check/tmp/google-warm/velora-session.json");
    }
    if (!["dom", "cdp"].includes(out.input)) {
        throw new Error("--input must be dom or cdp");
    }
    return out;
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function waitForCdp(url, ms = 20_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try {
            if ((await fetch(url)).ok) return;
        } catch (_) {}
        await delay(100);
    }
    throw new Error(`CDP not ready: ${url}`);
}

function veloraArgs(opts, port) {
    const args = [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--log-level", "warn",
    ];
    if (opts.profilePool) {
        args.push("--browser-profile-pool", opts.profilePool);
    } else {
        args.push("--browser-profile", opts.profile);
    }
    // Warm mode: restore Velora-owned session from prior cookie-jar (not Chrome import).
    const sessionLoad = opts.cookie
        ?? (opts.mode === "warm" && opts.cookieJar && existsSync(opts.cookieJar) ? opts.cookieJar : null);
    if (sessionLoad) args.push("--cookie", sessionLoad);
    if (opts.cookieJar) args.push("--cookie-jar", opts.cookieJar);
    if (opts.chromeTransport) args.push("--google-chrome-transport");
    return args;
}

async function spawnVelora(opts) {
    if (!existsSync(veloraBin)) throw new Error("Run `zig build` first");
    const port = await getFreePort();
    const stderr = [];
    const proc = spawn(veloraBin, veloraArgs(opts, port), {
        cwd: repoRoot,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, VELORA_ROOT: repoRoot },
    });
    proc.stderr.on("data", (c) => stderr.push(c));
    const endpoint = `http://127.0.0.1:${port}`;
    await waitForCdp(`${endpoint}/json/version`);
    return { proc, endpoint, stderr, port };
}

const CONSENT_SCRIPT = `(() => {
    const buttons = [...document.querySelectorAll("button")];
    const reject = buttons.find((b) => /reject all|từ chối|refuse/i.test(b.innerText || ""));
    const accept = buttons.find((b) => /accept all|đồng ý|agree|i agree|accept/i.test(b.innerText || ""));
    const btn = reject || accept;
    if (btn) {
        btn.click();
        return { clicked: (btn.innerText || "").trim().slice(0, 80), kind: reject ? "reject" : "accept" };
    }
    return { clicked: null };
})()`;

const FINGERPRINT_PROBE = `(() => {
    const plugins = navigator.plugins;
    return {
        url: location.href,
        title: document.title,
        webdriver: navigator.webdriver,
        ua: navigator.userAgent,
        platform: navigator.platform,
        languages: [...(navigator.languages || [])],
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory ?? null,
        pluginCount: plugins?.length ?? 0,
        pluginNames: plugins ? [...plugins].map((p) => p.name) : [],
        chrome: typeof window.chrome,
        chromeLoadTimes: typeof window.chrome?.loadTimes,
        hasSearchBox: !!document.querySelector('textarea[name="q"], input[name="q"]'),
    };
})()`;

const SERP_PROBE = `(() => {
    const items = [...document.querySelectorAll("#search .g h3, #rso .g h3, .MjjYud h3")]
        .slice(0, 12)
        .map((h3) => {
            const a = h3.closest("a[href]") || h3.parentElement?.querySelector("a[href]");
            return {
                title: (h3.innerText || "").trim().slice(0, 140),
                href: a?.href || "",
            };
        })
        .filter((x) => x.title || x.href);

    const unique = [];
    const seen = new Set();
    for (const it of items) {
        const k = it.href || it.title;
        if (seen.has(k)) continue;
        seen.add(k);
        unique.push(it);
    }

    const body = document.body?.innerText || "";
    const blockedSorry =
        location.href.includes("/sorry") ||
        /unusual traffic|not a robot|recaptcha|xác minh/i.test(body);

    const captchaIframe = !!document.querySelector(
        'iframe[src*="recaptcha"], iframe[src*="google.com/recaptcha"]'
    );

    return {
        title: document.title,
        url: location.href,
        resultCount: unique.length,
        results: unique.slice(0, 6),
        blockedSorry,
        captchaIframe,
        bodySnippet: body.slice(0, 800),
    };
})()`;

const SEARCH_BOX_PROBE = `(() => {
    const el = document.querySelector('textarea[name="q"], input[name="q"]');
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    return {
        found: true,
        tag: el.tagName,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        width: r.width,
        height: r.height,
    };
})()`;

async function dismissConsent(page) {
    return page.evaluate(CONSENT_SCRIPT).catch(() => ({ clicked: null }));
}

async function readFingerprint(page) {
    return page.evaluate(FINGERPRINT_PROBE).catch((e) => ({ error: String(e) }));
}

async function readSerp(page) {
    return page.evaluate(SERP_PROBE).catch((e) => ({
        error: String(e),
        resultCount: 0,
        blockedSorry: false,
        url: "",
        results: [],
    }));
}

const DOM_FILL_SCRIPT = `(q) => {
    const el = document.querySelector('textarea[name="q"], input[name="q"]');
    if (!el) return { ok: false, reason: "no_input" };
    el.focus();
    el.value = "";
    for (const ch of q) {
        el.value += ch;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, length: q.length };
}`;

const DOM_SUBMIT_SCRIPT = `(() => {
    const el = document.querySelector('textarea[name="q"], input[name="q"]');
    if (!el) return { ok: false, reason: "no_input" };
    el.value = String(el.value || "").trim();
    const form = el.closest("form");
    if (form) {
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.submit();
        return { ok: true, method: "form_submit" };
    }
    return { ok: true, method: "enter_key" };
})()`;

function isContextDestroyed(err) {
    return /execution context was destroyed/i.test(String(err?.message ?? err));
}

async function waitForSearchNavigation(page, timeout) {
    await page.waitForFunction(
        `() => /google\\.com\\/search|google\\.com\\/sorry/.test(location.href)`,
        { timeout, pollingMs: 200 },
    ).catch(() => {});
}

async function domSearchSubmit(page, query, timeout) {
    const fill = await page.evaluate(`(${DOM_FILL_SCRIPT})(${JSON.stringify(query)})`);
    if (!fill?.ok) return fill;

    const nav = waitForSearchNavigation(page, timeout);
    let submit;
    try {
        submit = await page.evaluate(DOM_SUBMIT_SCRIPT);
    } catch (err) {
        if (!isContextDestroyed(err)) throw err;
        submit = { ok: true, method: "nav_started" };
    }
    await nav;
    return { ...submit, ok: true, length: fill.length };
}

async function cdpSearchSubmit(page, box, query) {
    const session = page.session;
    const { x, y } = box;
    await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers: 0 });
    await delay(50);
    await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await delay(200);
    await session.send("Input.insertText", { text: query });
    await delay(150);
    await session.send("Input.dispatchKeyEvent", {
        type: "keyDown", key: "Enter", code: "Enter",
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    await session.send("Input.dispatchKeyEvent", {
        type: "keyUp", key: "Enter", code: "Enter",
        windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    return { ok: true, method: "cdp_input" };
}

async function gentleScroll(page, amount = 120) {
    await page.evaluate(`(() => {
        window.scrollBy({ top: ${amount}, behavior: "smooth" });
    })()`).catch(() => {});
    await delay(500 + Math.floor(Math.random() * 400));
}

const WARM_FOCUS_SCRIPT = `(() => {
    const el = document.querySelector('textarea[name="q"], input[name="q"]');
    if (!el) return { focused: false };
    el.focus();
    const r = el.getBoundingClientRect();
    return { focused: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

async function warmSession(page, opts) {
    console.log(`[warm] landing ${GOOGLE_HOME}`);
    await page.goto(GOOGLE_HOME, { waitUntil: "domcontentloaded", timeout: opts.timeout });
    await delay(opts.settleMs);

    const consent = await dismissConsent(page);
    if (consent.clicked) {
        console.log(`[warm] consent ${consent.kind}: ${consent.clicked}`);
        await delay(opts.settleMs);
    }

    console.log(`[warm] dwell ${opts.warmDwellMs}ms`);
    await delay(opts.warmDwellMs);

    for (let i = 0; i < opts.warmScrolls; i += 1) {
        const delta = 80 + Math.floor(Math.random() * 100);
        console.log(`[warm] scroll ${i + 1}/${opts.warmScrolls} (+${delta}px)`);
        await gentleScroll(page, delta);
    }

    const focus = await page.evaluate(WARM_FOCUS_SCRIPT).catch(() => ({ focused: false }));
    if (focus.focused) {
        console.log(`[warm] focus search box ${opts.warmFocusMs}ms`);
        await delay(opts.warmFocusMs);
        await page.evaluate(`(() => {
            const el = document.querySelector('textarea[name="q"], input[name="q"]');
            if (el) el.blur();
        })()`).catch(() => {});
    }

    console.log(`[warm] final dwell ${opts.warmDwellMs}ms`);
    await delay(opts.warmDwellMs);

    const fingerprint = await readFingerprint(page);
    return {
        consent,
        fingerprint,
        focus,
        scrolls: opts.warmScrolls,
        dwellMs: opts.warmDwellMs * 2 + opts.warmFocusMs,
    };
}

async function searchViaHomepage(page, query, opts, { skipLanding = false, warm = null } = {}) {
    let consent = warm?.consent ?? { clicked: null };
    let fp0 = warm?.fingerprint ?? null;

    if (!skipLanding) {
        console.log(`[goto] ${GOOGLE_HOME}`);
        await page.goto(GOOGLE_HOME, { waitUntil: "domcontentloaded", timeout: opts.timeout });
        await delay(opts.settleMs);

        consent = await dismissConsent(page);
        if (consent.clicked) {
            console.log(`[consent] ${consent.kind}: ${consent.clicked}`);
            await delay(opts.settleMs);
        }

        fp0 = await readFingerprint(page);
    }
    const box = await page.evaluate(SEARCH_BOX_PROBE).catch(() => ({ found: false }));

    if (!box.found) {
        return {
            method: "homepage",
            error: "search_box_not_found",
            fingerprint: fp0,
            consent,
        };
    }

    let submit;
    if (opts.input === "cdp") {
        console.log(`[search] cdp click (${box.x.toFixed(0)}, ${box.y.toFixed(0)}) type "${query}"`);
        submit = await cdpSearchSubmit(page, box, query);
    } else {
        console.log(`[search] dom type + submit "${query}"`);
        submit = await domSearchSubmit(page, query, opts.timeout);
    }
    if (!submit?.ok) {
        return {
            method: "homepage",
            error: submit?.reason ?? "submit_failed",
            fingerprint: fp0,
            consent,
            searchBox: box,
        };
    }
    console.log(`[search] submitted via ${submit.method}`);
    await delay(opts.settleMs + 1000);
    await gentleScroll(page);
    await delay(800);

    const fingerprint = await readFingerprint(page);
    const serp = await readSerp(page);
    return {
        method: warm ? "warm" : "homepage",
        input: opts.input,
        warm,
        submit,
        consent,
        fingerprint,
        serp,
        searchBox: box,
    };
}

async function searchViaWarm(page, query, opts) {
    const warm = await warmSession(page, opts);
    return searchViaHomepage(page, query, opts, { skipLanding: true, warm });
}

async function searchViaDirect(page, query, opts) {
    const url = searchUrl(query);
    console.log(`[goto] ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeout });
    await delay(opts.settleMs);

    const consent = await dismissConsent(page);
    if (consent.clicked) {
        console.log(`[consent] ${consent.kind}: ${consent.clicked}`);
        await delay(opts.settleMs);
    }

    await gentleScroll(page);
    await delay(500);

    const fingerprint = await readFingerprint(page);
    const serp = await readSerp(page);
    return { method: "direct", consent, fingerprint, serp };
}

function classify(serp, engineOk) {
    const blockedSorry = !!serp?.blockedSorry || /\/sorry\//.test(serp?.url || "");
    const captcha = !!serp?.captchaIframe;
    const serpOk = engineOk && !blockedSorry && !captcha && (serp?.resultCount ?? 0) > 0;
    let verdict = "NO_RESULTS";
    if (!engineOk) verdict = "ENGINE_FAIL";
    else if (blockedSorry) verdict = "BLOCKED_SORRY";
    else if (captcha) verdict = "CAPTCHA";
    else if (serpOk) verdict = "SERP_OK";
    return { blockedSorry, captcha, serpOk, verdict };
}

function exitCodeFor(verdict) {
    if (verdict === "SERP_OK") return 0;
    if (verdict === "ENGINE_FAIL") return 2;
    return 1;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    await mkdir(opts.output, { recursive: true });

    let proc = null;
    let stderr = [];
    let endpoint = opts.endpoint;
    let spawned = null;

    if (!endpoint) {
        spawned = await spawnVelora(opts);
        proc = spawned.proc;
        stderr = spawned.stderr;
        endpoint = spawned.endpoint;
        const profileLabel = opts.profilePool ?? opts.profile;
        console.log(`[velora] ${endpoint} profile=${profileLabel}`);
    }

    const browser = await Browser.connect(endpoint);
    const errors = [];
    const t0 = Date.now();

    try {
        const page = await browser.newPage();
        page.session.on("Runtime.exceptionThrown", (e) => {
            errors.push(e?.exceptionDetails?.text ?? "exception");
        });

        const flow = opts.mode === "warm"
            ? await searchViaWarm(page, opts.query, opts)
            : opts.mode === "homepage"
                ? await searchViaHomepage(page, opts.query, opts)
                : await searchViaDirect(page, opts.query, opts);

        const serp = flow.serp ?? {};
        const fingerprint = flow.fingerprint ?? {};
        const engineOk = /google\.com/.test(fingerprint.url || serp.url || "");
        const { blockedSorry, captcha, serpOk, verdict } = classify(serp, engineOk);

        console.log("\n=== Fingerprint ===");
        console.log(`webdriver:  ${fingerprint.webdriver}`);
        console.log(`ua:         ${fingerprint.ua || "(unknown)"}`);
        console.log(`platform:   ${fingerprint.platform || "(unknown)"}`);
        console.log(`plugins:    ${fingerprint.pluginCount ?? "?"} ${(fingerprint.pluginNames || []).join(", ")}`);
        console.log(`chrome:     ${fingerprint.chrome} loadTimes=${fingerprint.chromeLoadTimes}`);

        console.log("\n=== SERP ===");
        console.log(`url:        ${serp.url || fingerprint.url || "(none)"}`);
        console.log(`hits:       ${serp.resultCount ?? 0}`);
        console.log(`sorry:      ${blockedSorry}`);
        console.log(`captcha:    ${captcha}`);
        for (const [i, r] of (serp.results || []).entries()) {
            console.log(`  ${i + 1}. ${r.title}`);
            console.log(`     ${r.href}`);
        }
        if ((serp.resultCount ?? 0) === 0 && serp.bodySnippet) {
            console.log("--- body ---");
            console.log(serp.bodySnippet.split("\n").slice(0, 12).join("\n"));
        }

        const googleReqs = [...page.network.requests.values()]
            .filter((r) => /google\.com|gstatic/i.test(r.url || ""))
            .slice(0, 20)
            .map((r) => ({
                url: r.url?.slice(0, 120),
                status: r.response?.status,
                failure: r.failureText,
            }));

        const report = {
            query: opts.query,
            profile: opts.profilePool ?? opts.profile,
            mode: opts.mode,
            input: opts.input,
            flow,
            engineOk,
            blockedSorry,
            captcha,
            serpOk,
            verdict,
            googleRequests: googleReqs,
            errors,
            durationMs: Date.now() - t0,
            cookieJar: opts.cookieJar ?? null,
            note: verdict === "SERP_OK"
                ? "Google Search OK — antidetect profile passed"
                : verdict === "BLOCKED_SORRY"
                    ? opts.mode === "warm"
                        ? "Still /sorry — re-run warm mode to accumulate Velora session; check TLS probe"
                        : "Unusual traffic /sorry — try --mode warm with --cookie-jar"
                    : verdict === "CAPTCHA"
                        ? "reCAPTCHA challenge shown"
                        : flow.error ?? "See serp bodySnippet",
        };

        const html = await page.content().catch(() => "");
        await writeFile(resolve(opts.output, "page.html"), html);
        await writeFile(resolve(opts.output, "report.json"), JSON.stringify(report, null, 2));
        if (stderr.length) {
            await writeFile(resolve(opts.output, "velora.log"), Buffer.concat(stderr).toString());
        }

        console.log(`\n=== Verdict: ${verdict} ===`);
        console.log(`saved: ${opts.output}/report.json`);
        if (opts.cookieJar) console.log(`session: cookies/localStorage → ${opts.cookieJar}`);

        await page.close().catch(() => {});
        process.exitCode = exitCodeFor(verdict);
    } finally {
        await browser.close().catch(() => {});
        if (proc) {
            proc.kill("SIGTERM");
            await delay(500);
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});