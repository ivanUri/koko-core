#!/usr/bin/env node
// Truy cập TikTok qua Velora — kiểm tra có bị captcha / verify chặn hay không.
//
// Usage:
//   node code-check/sites/tiktok/visit.mjs
//   node code-check/sites/tiktok/visit.mjs --url https://www.tiktok.com/foryou
//   node code-check/sites/tiktok/visit.mjs --endpoint http://127.0.0.1:9222 --settle 25

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

const DEFAULT_URL = "https://www.tiktok.com/";
const BROWSER_PROFILE = "chrome-macos-catalina";

function parseArgs(argv) {
    const out = {
        endpoint: process.env.VELORA_CDP || null,
        url: DEFAULT_URL,
        output: resolve(repoRoot, "code-check/tmp/tiktok-visit"),
        timeout: 90_000,
        settleSeconds: 18,
        pollSeconds: 45,
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
            case "--url": out.url = next(); break;
            case "--output": out.output = resolve(next()); break;
            case "--timeout": out.timeout = Number(next()); break;
            case "--settle": out.settleSeconds = Number(next()); break;
            case "--poll": out.pollSeconds = Number(next()); break;
            case "--help":
                console.log(`Usage: node visit.mjs [--url <tiktok-url>] [--endpoint <cdp>] [--settle <s>] [--poll <s>]`);
                process.exit(0);
                break;
            default:
                if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
        }
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

async function waitForCdp(url, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try {
            if ((await fetch(url)).ok) return;
        } catch (_) {}
        await delay(100);
    }
    throw new Error(`CDP not ready: ${url}`);
}

async function spawnVelora() {
    if (!existsSync(veloraBin)) throw new Error("Run `zig build` first");
    const port = await getFreePort();
    const stderr = [];
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", BROWSER_PROFILE,
        "--log-level", "warn",
    ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", (c) => stderr.push(c));
    const endpoint = `http://127.0.0.1:${port}`;
    await waitForCdp(`${endpoint}/json/version`);
    return { proc, endpoint, stderr };
}

const PROBE_SCRIPT = `(() => {
    const text = (document.body?.innerText || '').slice(0, 8000);
    const lower = text.toLowerCase();
    const href = location.href;
    const hrefLower = href.toLowerCase();

    const urlCaptcha = /(captcha|verify|challenge|secsdk|slardar|risk|security.check)/i.test(href);
    const title = document.title || '';

    const captchaIframes = [...document.querySelectorAll('iframe[src]')]
        .map((f) => f.src || '')
        .filter((s) => /captcha|verify|secsdk|byteoversea|tiktokv|arkose|funcaptcha|geetest|hcaptcha|recaptcha/i.test(s));

    const captchaNodes = document.querySelectorAll(
        '[class*="captcha" i], [id*="captcha" i], [class*="verify" i], [id*="verify" i], ' +
        '[class*="secsdk" i], [data-e2e*="captcha" i], #captcha-verify-container'
    ).length;

    const textHits = [];
    const patterns = [
        ['slider', /slide (the )?puzzle|drag the slider|kéo.*(thanh|puzzle)|trượt/i],
        ['verify_human', /verify (you are|to continue|human)|xác minh|security check|kiểm tra bảo mật/i],
        ['captcha_word', /\\bcaptcha\\b|人机验证|robot check/i],
        ['blocked', /access denied|request blocked|unusual traffic|too many requests/i],
        ['login_wall', /log in to tiktok|đăng nhập|sign up for tiktok/i],
    ];
    for (const [key, re] of patterns) {
        if (re.test(text) || re.test(title)) textHits.push(key);
    }

    const feedSignals = {
        videos: document.querySelectorAll('video').length,
        feedItems: document.querySelectorAll(
            '[data-e2e="recommend-list-item"], [data-e2e="browse-video"], ' +
            '[data-e2e="user-post-item"], article, [class*="DivItemContainer"]'
        ).length,
        navTabs: document.querySelectorAll(
            'a[href*="/foryou"], a[href*="/following"], [data-e2e="nav-foryou"], [data-e2e="nav-inbox"]'
        ).length,
        appRoot: !!document.querySelector('#app, #root, [id*="tiktok"]'),
    };

    const hasFeed = feedSignals.videos > 0 || feedSignals.feedItems > 0;
    const hasShell = feedSignals.appRoot || feedSignals.navTabs > 0 || /tiktok/i.test(title);

    const captchaScore =
        (urlCaptcha ? 2 : 0) +
        (captchaIframes.length > 0 ? 2 : 0) +
        (captchaNodes > 0 ? 1 : 0) +
        (textHits.includes('slider') ? 2 : 0) +
        (textHits.includes('verify_human') ? 2 : 0) +
        (textHits.includes('captcha_word') ? 2 : 0);

    const blocked = textHits.includes('blocked') || captchaScore >= 3;
    const captchaLikely = captchaScore >= 2 && !hasFeed;
    const loginOnly = textHits.includes('login_wall') && !hasFeed && captchaScore === 0;

    let verdict = 'unknown';
    if (blocked || captchaLikely) verdict = 'captcha_or_blocked';
    else if (hasFeed) verdict = 'feed_ok';
    else if (loginOnly) verdict = 'login_wall';
    else if (hasShell) verdict = 'shell_no_feed';
    else verdict = 'empty_or_stuck';

    return {
        title,
        url: href,
        verdict,
        captchaScore,
        blocked,
        captchaLikely,
        loginOnly,
        urlCaptcha,
        textHits,
        captchaIframes: captchaIframes.slice(0, 5),
        captchaNodes,
        feedSignals,
        hasFeed,
        hasShell,
        bodySnippet: text.slice(0, 600).replace(/\\s+/g, ' ').trim(),
    };
})()`;

function classifyReport(report) {
    const last = report.probes.at(-1) || {};
    const passed = last.verdict === "feed_ok";
    const captcha = last.verdict === "captcha_or_blocked" || last.captchaLikely === true;
    const partial = last.verdict === "shell_no_feed" || last.verdict === "login_wall";
    return { passed, captcha, partial, last };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    await mkdir(opts.output, { recursive: true });

    let proc = null;
    let stderr = [];
    let endpoint = opts.endpoint;
    if (!endpoint) {
        const s = await spawnVelora();
        proc = s.proc;
        stderr = s.stderr;
        endpoint = s.endpoint;
        console.log(`[velora] ${endpoint} profile=${BROWSER_PROFILE}`);
    }

    const browser = await Browser.connect(endpoint);
    const errors = [];
    const probes = [];
    const t0 = Date.now();

    try {
        const page = await browser.newPage();
        page.session.on("Runtime.exceptionThrown", (e) => {
            errors.push(e?.exceptionDetails?.text ?? "exception");
        });

        console.log(`[goto] ${opts.url}`);
        await page.goto(opts.url, { waitUntil: "load", timeout: opts.timeout });
        await delay(opts.settleSeconds * 1000);

        const pollEnd = Date.now() + opts.pollSeconds * 1000;
        while (Date.now() < pollEnd) {
            const atMs = Date.now() - t0;
            const snap = await page.evaluate(PROBE_SCRIPT).catch((e) => ({
                verdict: "eval_error",
                error: String(e),
            }));
            probes.push({ atMs, ...snap });
            console.log(
                `[probe +${atMs}ms] verdict=${snap.verdict} captchaScore=${snap.captchaScore ?? "?"} ` +
                `videos=${snap.feedSignals?.videos ?? 0} feedItems=${snap.feedSignals?.feedItems ?? 0}`
            );
            if (snap.verdict === "feed_ok" || snap.verdict === "captcha_or_blocked") break;
            await delay(2500);
        }

        const html = await page.content();
        const { passed, captcha, partial, last } = classifyReport({ probes });

        const report = {
            target: opts.url,
            profile: BROWSER_PROFILE,
            probes,
            errors,
            durationMs: Date.now() - t0,
            verdict: last.verdict,
            captchaDetected: captcha,
            passed,
            partial,
            summary: passed
                ? "TikTok feed loaded without captcha wall"
                : captcha
                    ? "Captcha or security verify detected"
                    : partial
                        ? `No captcha signal but limited access (${last.verdict})`
                        : `Inconclusive (${last.verdict})`,
        };

        await writeFile(resolve(opts.output, "page.html"), html);
        await writeFile(resolve(opts.output, "report.json"), JSON.stringify(report, null, 2));
        if (stderr.length) {
            await writeFile(resolve(opts.output, "velora.log"), Buffer.concat(stderr).toString());
        }

        console.log("\n=== TikTok visit ===");
        console.log(`url:      ${last.url || opts.url}`);
        console.log(`title:    ${last.title || "(none)"}`);
        console.log(`verdict:  ${last.verdict}`);
        if (last.textHits?.length) console.log(`textHits: ${last.textHits.join(", ")}`);
        if (last.captchaIframes?.length) console.log(`iframes:  ${last.captchaIframes.join(" | ")}`);
        if (last.bodySnippet) {
            console.log("--- body ---");
            console.log(last.bodySnippet);
        }
        console.log(`\n=== Result: ${passed ? "PASS" : captcha ? "FAIL (captcha)" : partial ? "PARTIAL" : "FAIL"} ===`);
        console.log(`saved: ${opts.output}/report.json`);

        await page.close().catch(() => {});
        process.exitCode = passed ? 0 : captcha ? 2 : 1;
    } finally {
        await browser.close().catch(() => {});
        if (proc) {
            proc.kill("SIGTERM");
            await delay(300);
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});