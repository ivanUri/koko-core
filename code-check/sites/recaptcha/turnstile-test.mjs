#!/usr/bin/env node
// Test Cloudflare Turnstile demo via Velora CDP.
// Flow: click Turnstile checkbox → click "Check"
// → POST /api/v1/captcha-demo/cloudflare-turnstile/verify
// → UI shows verify JSON with success:true (testing key metadata is OK).
//
// Usage:
//   node code-check/sites/recaptcha/turnstile-test.mjs
//   node code-check/sites/recaptcha/turnstile-test.mjs --keep

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Browser } from "../../../sdk/dist/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");

const TARGET_URL = "https://2captcha.com/demo/cloudflare-turnstile";
const BROWSER_PROFILE = "chrome-macos-catalina";
const SUCCESS_TEXT = "Captcha is passed successfully!";
const VERIFY_URL_RE = /2captcha\.com\/api\/v1\/captcha-demo\/cloudflare-turnstile\/verify/;

const CLICK_CHECK = `(() => {
    const candidates = [...document.querySelectorAll("button, input[type='submit'], [role='button']")];
    const checkBtn = candidates.find((el) => {
        const text = (el.innerText || el.textContent || el.value || "").trim();
        return /^check$/i.test(text);
    });
    if (!checkBtn) {
        return { ok: false, reason: "check_button_not_found", buttons: candidates.map((el) =>
            (el.innerText || el.textContent || el.value || "").trim().slice(0, 40)
        ) };
    }
    if (checkBtn.disabled) {
        return { ok: false, reason: "check_button_disabled", text: (checkBtn.innerText || "").trim() };
    }
    checkBtn.click();
    return { ok: true, text: (checkBtn.innerText || checkBtn.textContent || "").trim() };
})()`;

function parseArgs(argv) {
    const out = {
        endpoint: process.env.VELORA_CDP || null,
        keep: false,
        output: resolve(repoRoot, "code-check/tmp/turnstile-demo"),
        timeout: 90_000,
        waitSeconds: 8,
        checkboxPollSeconds: 20,
        pollSeconds: 45,
        logLevel: "warn",
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
            case "--checkbox-poll": out.checkboxPollSeconds = Number(next()); break;
            case "--log-level": out.logLevel = next(); break;
            case "--help":
                console.log("Usage: node turnstile-test.mjs [--endpoint <url>] [--keep] [--log-level debug]");
                process.exit(0);
                break;
            default:
                if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
        }
    }
    return out;
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function safeEvaluate(page, expression, fallback = null) {
    try {
        return await page.evaluate(expression);
    } catch (e) {
        const msg = e?.message ?? String(e);
        if (/Promise was collected|timed out/i.test(msg)) return fallback;
        throw e;
    }
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

async function spawnVelora(logLevel) {
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
            "--log-level", logLevel,
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

async function getWidgetBox(session) {
    await session.send("DOM.enable").catch(() => undefined);
    const doc = await session.send("DOM.getDocument", { depth: 0, pierce: false });
    const rootId = doc?.root?.nodeId;
    if (!rootId) return { error: "no_document_root" };

    const selectors = [
        ".cf-turnstile",
        "[data-sitekey]",
        "div[id*='turnstile']",
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
    return { error: "widget_not_found" };
}

function isVerifyResponseOk(payload) {
    if (!payload || typeof payload !== "object") return false;
    if (payload.success !== true) return false;
    const errors = payload["error-codes"];
    if (Array.isArray(errors) && errors.length > 0) return false;
    return true;
}

async function pollTurnstileState(page) {
    return safeEvaluate(page, `(() => {
        const body = document.body?.innerText || "";
        const input = document.querySelector('input[name="cf-turnstile-response"]')
            || document.querySelector('[name="cf-turnstile-response"]');
        const widget = document.querySelector('.cf-turnstile');
        const iframes = [...document.querySelectorAll('iframe')].map((f) => ({
            src: f.src || f.getAttribute('src') || '',
            w: f.offsetWidth,
            h: f.offsetHeight,
        }));

        let verifyResponse = null;
        const jsonCandidates = [
            ...document.querySelectorAll("pre, code, textarea, .verify-result, [class*='result']"),
        ].map((el) => (el.innerText || el.textContent || el.value || "").trim())
            .filter((t) => t.includes('"success"'));
        for (const text of jsonCandidates) {
            try {
                const parsed = JSON.parse(text);
                if (parsed && typeof parsed === "object" && "success" in parsed) {
                    verifyResponse = parsed;
                    break;
                }
            } catch (_) { /* try next */ }
        }
        const extractVerifyJson = (text) => {
            const key = '"success"';
            let from = 0;
            while (from < text.length) {
                const idx = text.indexOf(key, from);
                if (idx < 0) return null;
                const start = text.lastIndexOf("{", idx);
                if (start < 0) return null;
                let depth = 0;
                for (let i = start; i < text.length; i += 1) {
                    if (text[i] === "{") depth += 1;
                    else if (text[i] === "}") {
                        depth -= 1;
                        if (depth === 0) {
                            try {
                                const parsed = JSON.parse(text.slice(start, i + 1));
                                if (parsed?.success === true) return parsed;
                            } catch (_) { /* try next */ }
                            break;
                        }
                    }
                }
                from = idx + key.length;
            }
            return null;
        };

        for (const src of [body, document.body?.innerHTML || ""]) {
            verifyResponse = extractVerifyJson(src);
            if (verifyResponse) break;
        }

        const verifyPassed = !!(
            verifyResponse &&
            verifyResponse.success === true &&
            (!Array.isArray(verifyResponse["error-codes"]) || verifyResponse["error-codes"].length === 0)
        );

        return {
            tokenLength: input?.value?.length ?? 0,
            tokenPreview: input?.value ? input.value.slice(0, 48) + '...' : '',
            widgetVisible: !!widget,
            widgetSize: widget ? { w: widget.offsetWidth, h: widget.offsetHeight } : null,
            widgetState: widget?.getAttribute('data-state') || null,
            iframeCount: iframes.length,
            iframes,
            turnstileType: typeof turnstile,
            hasSuccessText: body.includes(${JSON.stringify(SUCCESS_TEXT)}),
            verifyResponse,
            verifyPassed,
            bodySnippet: body.slice(0, 500),
        };
    })()`, {
        tokenLength: 0,
        verifyPassed: false,
        hasSuccessText: false,
        verifyResponse: null,
    });
}

function findVerifyRequest(requests) {
    for (const r of requests) {
        if (!VERIFY_URL_RE.test(r.url || "")) continue;
        if (r.method !== "POST") continue;
        return {
            url: r.url,
            status: r.response?.status,
            failure: r.failureText,
        };
    }
    return null;
}

function buildVerdict(report) {
    if (report.verifyResponseOk || report.hasSuccessText || report.verifyPassed) return "verify_passed";
    if (report.tokenLength > 0 && report.strategies?.checkClick?.startsWith("ok")) {
        return "token_ready_but_verify_failed";
    }
    if (report.tokenLength > 0) return "token_received";
    if (!report.turnstileLoaded && report.networkErrors.length) return "network_blocked";
    if (!report.widgetFound) return "widget_missing";
    if (report.strategies?.checkClick && !report.strategies.checkClick.startsWith("ok")) {
        return "check_button_failed";
    }
    if (report.strategies?.coordinateClick?.startsWith("ok")) return "checkbox_clicked_but_no_token";
    return "widget_loaded_but_no_token";
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    await mkdir(opts.output, { recursive: true });

    let veloraProc = null;
    let veloraStderr = [];
    let endpoint = opts.endpoint;

    if (!endpoint) {
        const spawned = await spawnVelora(opts.logLevel);
        veloraProc = spawned.proc;
        veloraStderr = spawned.stderr;
        endpoint = spawned.endpoint;
        console.log(`[velora] spawned at ${endpoint} (profile=${BROWSER_PROFILE})`);
    }

    const t0 = Date.now();
    const jsErrors = [];
    const networkErrors = [];
    const frameNavs = [];
    const strategies = {};

    const report = {
        url: TARGET_URL,
        profile: BROWSER_PROFILE,
        passed: false,
        turnstileLoaded: false,
        widgetFound: false,
        widgetBox: null,
        strategies: {},
        tokenLength: 0,

        networkErrors: [],
        consoleErrors: [],
        frameNavigations: [],
        microtaskAborts: 0,
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

        page.session.on("Page.frameNavigated", (event) => {
            const url = event?.frame?.url || "";
            if (/cloudflare|turnstile|challenges/i.test(url)) {
                frameNavs.push({ url, frameId: event?.frame?.id });
            }
        });

        await page.session.send("Input.enable").catch(() => undefined);
        await page.session.send("Page.enable").catch(() => undefined);

        console.log(`[goto] ${TARGET_URL}`);
        await page.goto(TARGET_URL, { waitUntil: "load", timeout: opts.timeout });

        if (opts.waitSeconds > 0) {
            console.log(`[wait] ${opts.waitSeconds}s for Turnstile widget`);
            await delay(opts.waitSeconds * 1000);
        }

        const probe = await page.evaluate(`(() => ({
            title: document.title,
            url: location.href,
            turnstile: typeof turnstile,
            webdriver: navigator.webdriver,
            userAgent: navigator.userAgent,
            sitekey: document.querySelector('.cf-turnstile')?.dataset?.sitekey || null,
            widgetHtml: document.querySelector('.cf-turnstile')?.innerHTML?.slice(0, 300) || null,
            iframeCount: document.querySelectorAll('iframe').length,
            cfIframes: [...document.querySelectorAll('iframe')]
                .map((f) => f.src || f.getAttribute('src') || '')
                .filter((s) => /cloudflare|turnstile|challenges/i.test(s)),
        }))()`).catch((e) => ({ error: String(e) }));

        console.log("\n=== Probe ===");
        console.log(JSON.stringify(probe, null, 2));

        report.turnstileLoaded =
            probe.turnstile === "object" ||
            (probe.cfIframes?.length ?? 0) > 0;

        const viewportBox = await page.evaluate(`(() => {
            const widget = document.querySelector('.cf-turnstile');
            if (!widget) return { error: 'no_widget' };
            widget.scrollIntoView({ block: 'center', inline: 'center' });
            const r = widget.getBoundingClientRect();
            return {
                left: r.left, top: r.top, width: r.width, height: r.height,
                centerX: r.left + r.width / 2,
                centerY: r.top + r.height / 2,
                scrollY: scrollY,
                innerHeight: innerHeight,
                inView: r.top >= 0 && r.top < innerHeight,
            };
        })()`);

        if (viewportBox.error) {
            console.log(`[widget] not found: ${viewportBox.error}`);
            strategies.coordinateClick = "skipped_no_widget";
        } else {
            report.widgetFound = true;
            report.widgetBox = viewportBox;
            console.log(`[widget] viewport center=(${viewportBox.centerX.toFixed(1)}, ${viewportBox.centerY.toFixed(1)}) scrollY=${viewportBox.scrollY} inView=${viewportBox.inView}`);

            // Checkbox is on the left side of the widget (not geometric center).
            const clickX = viewportBox.left + 28;
            const clickY = viewportBox.top + viewportBox.height / 2;

            try {
                for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
                    await page.session.send("Input.dispatchMouseEvent", {
                        type,
                        x: clickX,
                        y: clickY,
                        button: type === "mouseMoved" ? "none" : "left",
                        clickCount: type === "mousePressed" ? 1 : 0,
                    });
                    await delay(80);
                }
                strategies.coordinateClick = `ok@${clickX.toFixed(1)},${clickY.toFixed(1)}`;
                console.log(`[click] coordinate at widget center (${clickX.toFixed(1)}, ${clickY.toFixed(1)})`);
            } catch (e) {
                strategies.coordinateClick = `error:${e?.message ?? e}`;
                console.log(`[click] coordinate failed: ${e?.message ?? e}`);
            }
        }

        try {
            const domClick = await page.evaluate(`(() => {
                const widget = document.querySelector('.cf-turnstile');
                if (!widget) return { ok: false, reason: 'no_widget' };
                const r = widget.getBoundingClientRect();
                widget.dispatchEvent(new MouseEvent('click', {
                    bubbles: true, cancelable: true, composed: true,
                    clientX: r.left + r.width / 2,
                    clientY: r.top + r.height / 2,
                }));
                return { ok: true, rect: { left: r.left, top: r.top, width: r.width, height: r.height } };
            })()`);
            strategies.domClick = domClick.ok ? `ok@${JSON.stringify(domClick.rect)}` : `skip:${domClick.reason}`;
            console.log(`[click] DOM: ${strategies.domClick}`);
        } catch (e) {
            strategies.domClick = `error:${e?.message ?? e}`;
        }

        console.log(`[poll] up to ${opts.checkboxPollSeconds}s for token after checkbox`);
        let lastState = null;
        const checkboxPollEnd = Date.now() + opts.checkboxPollSeconds * 1000;
        while (Date.now() < checkboxPollEnd) {
            lastState = await pollTurnstileState(page);
            if (lastState?.tokenLength > 0) break;
            await delay(1500);
        }
        report.tokenLength = lastState?.tokenLength ?? 0;
        console.log(`[token] after checkbox: length=${report.tokenLength} state=${lastState?.widgetState ?? "?"}`);

        console.log("[click] Check button (2captcha demo submits token to verify API)");
        const checkClick = await page.evaluate(CLICK_CHECK).catch((e) => ({
            ok: false,
            reason: String(e),
        }));
        strategies.checkClick = checkClick.ok
            ? `ok@${checkClick.text}`
            : `fail:${checkClick.reason}${checkClick.buttons ? `@${JSON.stringify(checkClick.buttons)}` : ""}`;
        console.log(`[click] Check: ${strategies.checkClick}`);

        console.log(`[poll] up to ${opts.pollSeconds}s for verify success`);
        const pollEnd = Date.now() + opts.pollSeconds * 1000;
        while (Date.now() < pollEnd) {
            lastState = await pollTurnstileState(page);
            const verifyReq = findVerifyRequest([...page.network.requests.values()]);
            if (lastState?.verifyPassed || lastState?.hasSuccessText || verifyReq?.status === 200) break;
            await delay(1500);
        }

        const verifyReq = findVerifyRequest([...page.network.requests.values()]);
        report.verifyRequest = verifyReq;
        report.verifyResponse = lastState?.verifyResponse ?? null;
        report.verifyResponseOk = isVerifyResponseOk(lastState?.verifyResponse);
        report.verifyPassed = !!(
            report.verifyResponseOk ||
            lastState?.hasSuccessText ||
            verifyReq?.status === 200
        );
        report.hasSuccessText = lastState?.hasSuccessText ?? false;
        report.tokenLength = lastState?.tokenLength ?? report.tokenLength;
        report.strategies = strategies;
        report.frameNavigations = frameNavs;

        console.log("\n=== Turnstile state ===");
        console.log(`tokenLength:       ${report.tokenLength}`);
        console.log(`hasSuccessText:    ${report.hasSuccessText}`);
        console.log(`verifyResponseOk:  ${report.verifyResponseOk}`);
        if (report.verifyResponse) {
            console.log(`verify JSON:       ${JSON.stringify(report.verifyResponse)}`);
        }
        console.log(`verify POST:       ${verifyReq ? `[${verifyReq.status}] ${verifyReq.url}` : "none"}`);

        console.log(`iframeCount (light): ${lastState?.iframeCount ?? 0}`);
        if (lastState?.iframes?.length) {
            console.log("light-DOM iframes:");
            for (const f of lastState.iframes) {
                console.log(`  ${f.w}x${f.h} ${f.src.slice(0, 90)}`);
            }
        }
        if (frameNavs.length) {
            console.log("CF frame navigations:");
            for (const f of frameNavs) {
                console.log(`  [${f.frameId}] ${f.url.slice(0, 100)}`);
            }
        }
        if (lastState?.bodySnippet) {
            console.log("--- body snippet ---");
            console.log(lastState.bodySnippet);
        }

        const reqs = [...page.network.requests.values()];
        const cfReqs = reqs.filter((r) =>
            /cloudflare|turnstile|challenges/i.test(r.url || "") || VERIFY_URL_RE.test(r.url || "")
        );
        const failed = reqs.filter((r) => r.failureText);
        for (const r of failed) {
            if (/cloudflare|turnstile|2captcha/i.test(r.url || "")) {
                networkErrors.push({ url: r.url, failure: r.failureText });
            }
        }

        console.log("\n=== Turnstile network (sample) ===");
        for (const r of cfReqs.slice(0, 15)) {
            const st = r.response?.status ?? (r.failureText ? `ERR:${r.failureText}` : "pending");
            console.log(`  [${st}] ${r.url?.slice(0, 110)}`);
        }

        const stderrText = Buffer.concat(veloraStderr).toString("utf8");
        const microtaskAborts = (stderrText.match(/checkpoint_aborted/g) || []).length;
        report.microtaskAborts = microtaskAborts;
        report.inputActivations = stderrText.split("\n")
            .filter((l) => /input activation/i.test(l))
            .map((l) => l.trim().slice(0, 200));
        report.postMessageLogs = stderrText.split("\n")
            .filter((l) => /postMessage/i.test(l))
            .map((l) => l.trim().slice(0, 200));
        report.networkErrors = networkErrors;
        report.consoleErrors = [...jsErrors];
        report.passed = report.verifyResponseOk || report.verifyPassed || report.hasSuccessText;
        report.verdict = buildVerdict(report);
        report.durationMs = Date.now() - t0;

        if (microtaskAborts > 0) {
            console.log(`\n[microtask] checkpoint_aborted count: ${microtaskAborts}`);
        }
        if (report.inputActivations?.length) {
            console.log("\n=== Input activations ===");
            for (const l of report.inputActivations) console.log(`  ${l}`);
        }
        if (report.postMessageLogs?.length) {
            console.log("\n=== postMessage logs ===");
            for (const l of report.postMessageLogs.slice(0, 10)) console.log(`  ${l}`);
        }

        await writeFile(resolve(opts.output, "report.json"), JSON.stringify({
            ...report,
            probe,
            lastState,
            cfRequests: cfReqs.map((r) => ({
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