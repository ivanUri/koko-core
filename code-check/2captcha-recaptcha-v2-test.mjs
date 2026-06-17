#!/usr/bin/env node
// Test 2captcha reCAPTCHA v2 demo via Velora CDP.
//
// Usage:
//   node code-check/2captcha-recaptcha-v2-test.mjs
//   node code-check/2captcha-recaptcha-v2-test.mjs --keep

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Browser } from "../sdk/dist/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");

const TARGET_URL = "https://2captcha.com/demo/recaptcha-v2";
const BROWSER_PROFILE = "chrome-macos-catalina";

function parseArgs(argv) {
    const out = {
        endpoint: process.env.VELORA_CDP || null,
        keep: false,
        output: resolve(repoRoot, "code-check/tmp/2captcha-recaptcha-v2"),
        timeout: 90_000,
        waitSeconds: 12,
        pollSeconds: 40,
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
            case "--keep": out.keep = true; break;
            case "--output": out.output = resolve(next()); break;
            case "--timeout": out.timeout = Number(next()); break;
            case "--wait": out.waitSeconds = Number(next()); break;
            case "--poll": out.pollSeconds = Number(next()); break;
            case "--help":
                console.log("Usage: node 2captcha-recaptcha-v2-test.mjs [--endpoint <url>] [--keep]");
                process.exit(0);
                break;
            default:
                if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
        }
    }
    return out;
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

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

async function waitForCdp(url, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(url);
            if (r.ok) return;
        } catch (_) { /* not ready */ }
        await delay(100);
    }
    throw new Error(`CDP not ready: ${url}`);
}

async function spawnVelora() {
    if (!existsSync(veloraBin)) {
        throw new Error(`Velora binary not found at ${veloraBin}. Run \`zig build\` first.`);
    }
    const port = await getFreePort();
    const stderr = [];
    const proc = spawn(
        veloraBin,
        [
            "serve",
            "--host", "127.0.0.1",
            "--port", String(port),
            "--browser-profile", BROWSER_PROFILE,
            "--log-level", "warn",
            "--log-format", "pretty",
        ],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    proc.stderr.on("data", (c) => stderr.push(c));
    const endpoint = `http://127.0.0.1:${port}`;
    await waitForCdp(`${endpoint}/json/version`);
    return { proc, endpoint, stderr };
}

function quadCenter(quad) {
    if (!quad || quad.length < 8) return null;
    const xs = [quad[0], quad[2], quad[4], quad[6]];
    const ys = [quad[1], quad[3], quad[5], quad[7]];
    return {
        x: xs.reduce((a, b) => a + b, 0) / xs.length,
        y: ys.reduce((a, b) => a + b, 0) / ys.length,
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
    };
}

async function getIframeBox(session) {
    await session.send("DOM.enable").catch(() => undefined);
    const doc = await session.send("DOM.getDocument", { depth: 0, pierce: false });
    const rootId = doc?.root?.nodeId;
    if (!rootId) return { error: "no_document_root" };

    const selectors = [
        ".g-recaptcha iframe",
        "iframe[src*='recaptcha']",
        "iframe[title*='reCAPTCHA']",
        "iframe[src*='google.com/recaptcha']",
    ];

    for (const selector of selectors) {
        try {
            const qs = await session.send("DOM.querySelector", { nodeId: rootId, selector });
            if (!qs?.nodeId) continue;
            const box = await session.send("DOM.getBoxModel", { nodeId: qs.nodeId });
            const center = quadCenter(box?.model?.content);
            if (center && center.width > 0 && center.height > 0) {
                return { selector, nodeId: qs.nodeId, box: center, raw: box?.model };
            }
        } catch (_) { /* try next */ }
    }
    return { error: "iframe_not_found" };
}

async function pollCaptchaState(page) {
    return page.evaluate(`(() => {
        const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
        const challenge = document.querySelector('iframe[src*="bframe"], iframe[src*="recaptcha/api2/bframe"]');
        const widget = document.querySelector('.g-recaptcha, [data-sitekey]');
        const checkBtn = document.querySelector('#recaptcha-demo-submit, button[type="submit"], input[type="submit"]');
        const iframes = [...document.querySelectorAll('iframe')].map((f) => ({
            src: f.src || f.getAttribute('src') || '',
            title: f.title || '',
            w: f.offsetWidth,
            h: f.offsetHeight,
        }));
        return {
            tokenLength: ta?.value?.length ?? 0,
            tokenPreview: ta?.value ? ta.value.slice(0, 48) + '...' : '',
            challengeVisible: !!challenge,
            widgetVisible: !!widget,
            submitVisible: !!checkBtn,
            iframeCount: iframes.length,
            iframes,
            grecaptchaType: typeof grecaptcha,
            bodySnippet: (document.body?.innerText || '').slice(0, 500),
        };
    })()`);
}

function buildVerdict(report) {
    if (report.tokenLength > 0) return "token_received";
    if (!report.recaptchaScriptLoaded && report.networkErrors.length) return "network_blocked";
    if (!report.iframeFound) return "widget_iframe_missing";
    if (report.challengeVisible) return "image_challenge_shown";
    if (report.strategies?.coordinateClick?.startsWith("ok")) return "clicked_but_no_token";
    return "widget_loaded_but_no_token";
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    await mkdir(opts.output, { recursive: true });

    let veloraProc = null;
    let veloraStderr = [];
    let endpoint = opts.endpoint;

    if (!endpoint) {
        const spawned = await spawnVelora();
        veloraProc = spawned.proc;
        veloraStderr = spawned.stderr;
        endpoint = spawned.endpoint;
        console.log(`[velora] spawned at ${endpoint} (profile=${BROWSER_PROFILE})`);
    }

    const t0 = Date.now();
    const jsErrors = [];
    const networkErrors = [];
    const strategies = {};

    const report = {
        url: TARGET_URL,
        profile: BROWSER_PROFILE,
        passed: false,
        recaptchaScriptLoaded: false,
        iframeFound: false,
        iframeBox: null,
        strategies: {},
        tokenLength: 0,
        challengeVisible: false,
        networkErrors: [],
        consoleErrors: [],
        verdict: "pending",
        durationMs: 0,
    };

    const browser = await Browser.connect(endpoint);

    try {
        const page = await browser.newPage();

        page.session.on("Runtime.exceptionThrown", (event) => {
            const ex = event.exceptionDetails;
            jsErrors.push(ex?.exception?.description ?? ex?.text ?? "unknown exception");
        });

        await page.session.send("Input.enable").catch(() => undefined);

        console.log(`[goto] ${TARGET_URL}`);
        await page.goto(TARGET_URL, { waitUntil: "load", timeout: opts.timeout });

        if (opts.waitSeconds > 0) {
            console.log(`[wait] ${opts.waitSeconds}s for reCAPTCHA widget`);
            await delay(opts.waitSeconds * 1000);
        }

        const probe = await page.evaluate(`(() => ({
            title: document.title,
            url: location.href,
            grecaptcha: typeof grecaptcha,
            cfg: typeof ___grecaptcha_cfg,
            webdriver: navigator.webdriver,
            userAgent: navigator.userAgent,
            sitekey: document.querySelector('[data-sitekey]')?.getAttribute('data-sitekey') || null,
            iframeCount: document.querySelectorAll('iframe').length,
            recaptchaIframes: [...document.querySelectorAll('iframe')]
                .map((f) => f.src || f.getAttribute('src') || '')
                .filter((s) => /recaptcha/i.test(s)),
        }))()`).catch((e) => ({ error: String(e) }));

        console.log("\n=== Probe ===");
        console.log(JSON.stringify(probe, null, 2));

        report.recaptchaScriptLoaded =
            probe.grecaptcha === "object" ||
            probe.cfg === "object" ||
            (probe.recaptchaIframes?.length ?? 0) > 0;

        const iframeBox = await getIframeBox(page.session);
        if (iframeBox.error) {
            console.log(`[iframe] not found: ${iframeBox.error}`);
            strategies.coordinateClick = "skipped_no_iframe";
        } else {
            report.iframeFound = true;
            report.iframeBox = iframeBox.box;
            console.log(`[iframe] ${iframeBox.selector} center=(${iframeBox.box.x.toFixed(1)}, ${iframeBox.box.y.toFixed(1)}) size=${iframeBox.box.width.toFixed(0)}x${iframeBox.box.height.toFixed(0)}`);

            // Click near checkbox area (left side of widget iframe, not center)
            const clickX = iframeBox.box.x - iframeBox.box.width / 2 + 28;
            const clickY = iframeBox.box.y;

            try {
                for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
                    await page.session.send("Input.dispatchMouseEvent", {
                        type,
                        x: clickX,
                        y: clickY,
                        button: type === "mouseMoved" ? "none" : "left",
                        clickCount: type === "mousePressed" ? 1 : 0,
                    });
                    await delay(60);
                }
                strategies.coordinateClick = `ok@${clickX.toFixed(1)},${clickY.toFixed(1)}`;
                console.log(`[click] coordinate at checkbox area (${clickX.toFixed(1)}, ${clickY.toFixed(1)})`);
            } catch (e) {
                strategies.coordinateClick = `error:${e?.message ?? e}`;
                console.log(`[click] coordinate failed: ${e?.message ?? e}`);
            }
        }

        // S2: DOM click on iframe element
        try {
            const domClick = await page.evaluate(`(() => {
                const iframe = document.querySelector('.g-recaptcha iframe')
                    || document.querySelector('iframe[src*="recaptcha"]');
                if (!iframe) return { ok: false, reason: 'no_iframe' };
                const r = iframe.getBoundingClientRect();
                iframe.dispatchEvent(new MouseEvent('click', {
                    bubbles: true, cancelable: true, composed: true,
                    clientX: r.left + 28,
                    clientY: r.top + r.height / 2,
                }));
                return { ok: true, rect: { left: r.left, top: r.top, width: r.width, height: r.height } };
            })()`);
            strategies.domClick = domClick.ok ? `ok@${JSON.stringify(domClick.rect)}` : `skip:${domClick.reason}`;
            console.log(`[click] DOM: ${strategies.domClick}`);
        } catch (e) {
            strategies.domClick = `error:${e?.message ?? e}`;
        }

        console.log(`[poll] up to ${opts.pollSeconds}s for token or challenge`);
        let lastState = null;
        const pollEnd = Date.now() + opts.pollSeconds * 1000;
        while (Date.now() < pollEnd) {
            lastState = await pollCaptchaState(page);
            if (lastState.tokenLength > 0 || lastState.challengeVisible) break;
            await delay(1500);
        }

        report.tokenLength = lastState?.tokenLength ?? 0;
        report.challengeVisible = lastState?.challengeVisible ?? false;
        report.strategies = strategies;

        console.log("\n=== Captcha state ===");
        console.log(`tokenLength:      ${report.tokenLength}`);
        console.log(`challengeVisible: ${report.challengeVisible}`);
        if (lastState?.iframes?.length) {
            console.log("iframes:");
            for (const f of lastState.iframes) {
                console.log(`  ${f.w}x${f.h} ${f.title || f.src.slice(0, 80)}`);
            }
        }
        if (lastState?.bodySnippet) {
            console.log("--- body snippet ---");
            console.log(lastState.bodySnippet);
        }

        const reqs = [...page.network.requests.values()];
        const recaptchaReqs = reqs.filter((r) => /recaptcha|gstatic\.com/i.test(r.url || ""));
        const failed = reqs.filter((r) => r.failureText);
        for (const r of failed) {
            if (/recaptcha|google|2captcha/i.test(r.url || "")) {
                networkErrors.push({ url: r.url, failure: r.failureText });
            }
        }

        console.log("\n=== reCAPTCHA network (sample) ===");
        for (const r of recaptchaReqs.slice(0, 12)) {
            const st = r.response?.status ?? (r.failureText ? `ERR:${r.failureText}` : "pending");
            console.log(`  [${st}] ${r.url?.slice(0, 110)}`);
        }

        report.networkErrors = networkErrors;
        report.consoleErrors = [...jsErrors];
        report.passed = report.tokenLength > 0;
        report.verdict = buildVerdict({
            ...report,
            recaptchaScriptLoaded: report.recaptchaScriptLoaded,
        });
        report.durationMs = Date.now() - t0;

        await writeFile(resolve(opts.output, "report.json"), JSON.stringify({
            ...report,
            probe,
            lastState,
            recaptchaRequests: recaptchaReqs.map((r) => ({
                url: r.url,
                status: r.response?.status,
                failure: r.failureText,
            })),
        }, null, 2));

        console.log("\n=== Verdict ===");
        console.log(`passed:  ${report.passed}`);
        console.log(`verdict: ${report.verdict}`);
        console.log(`saved:   ${opts.output}/report.json`);

        await page.close().catch(() => undefined);
    } finally {
        await browser.close().catch(() => undefined);
        if (veloraProc && !opts.keep) {
            veloraProc.kill("SIGTERM");
            await delay(300);
            if (!veloraProc.killed) veloraProc.kill("SIGKILL");
        }
    }

    process.exitCode = report.passed ? 0 : 1;
}

main().catch((err) => {
    console.error("FAILED:", err?.stack || err?.message || err);
    process.exit(1);
});