#!/usr/bin/env node
/**
 * Check https://2captcha.com/demo/cloudflare-turnstile
 *
 * PASS when the page UI shows verify JSON like:
 * {
 *   "challenge_ts": "2026-06-23T07:45:48.162Z",
 *   "error-codes": [],
 *   "hostname": "example.com",
 *   "metadata": { "result_with_testing_key": true },
 *   "success": true
 * }
 *
 * Usage:
 *   node code-check/sites/recaptcha/turnstile-2captcha-demo-check.mjs
 *   npm run test:site:turnstile:2captcha
 */

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
const OUTPUT_DIR = resolve(repoRoot, "code-check/tmp/turnstile-2captcha");

const TARGET_URL = "https://2captcha.com/demo/cloudflare-turnstile";
const BROWSER_PROFILE = "chrome-macos-catalina";
const VERIFY_URL_RE = /captcha-demo\/cloudflare-turnstile\/verify/;
const EXPECTED_HOSTNAME = "example.com";

/** Turnstile verify JSON only — ignore unrelated objects with a "success" field. */
const isTurnstileVerifyShape = (parsed) => {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    if (typeof parsed.success !== "boolean") return false;
    if (!Array.isArray(parsed["error-codes"])) return false;
    if (typeof parsed.challenge_ts !== "string") return false;
    if (typeof parsed.hostname !== "string") return false;
    return true;
};

const EXTRACT_UI_VERIFY_JSON = `(() => {
    const isTurnstileVerifyShape = (parsed) => {
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
        if (typeof parsed.success !== "boolean") return false;
        if (!Array.isArray(parsed["error-codes"])) return false;
        if (typeof parsed.challenge_ts !== "string") return false;
        if (typeof parsed.hostname !== "string") return false;
        return true;
    };

    const sources = [];

    const push = (text) => {
        if (!text || typeof text !== "string") return;
        if (text.includes("challenge_ts") && text.includes("error-codes")) sources.push(text);
    };

    for (const el of document.querySelectorAll(
        "pre, code, textarea, output, [class*='result'], [class*='response'], [class*='verify'], [id*='result'], [id*='response']"
    )) {
        push(el.innerText || el.textContent || "");
        push(el.value || "");
    }
    push(document.body?.innerText || "");

    const parseFromText = (text) => {
        const marker = '"challenge_ts"';
        let from = 0;
        while (from < text.length) {
            const idx = text.indexOf(marker, from);
            if (idx < 0) break;
            const start = text.lastIndexOf("{", idx);
            if (start < 0) break;
            let depth = 0;
            for (let i = start; i < text.length; i += 1) {
                const ch = text[i];
                if (ch === "{") depth += 1;
                else if (ch === "}") {
                    depth -= 1;
                    if (depth === 0) {
                        try {
                            const parsed = JSON.parse(text.slice(start, i + 1));
                            if (isTurnstileVerifyShape(parsed)) return parsed;
                        } catch { /* continue */ }
                        break;
                    }
                }
            }
            from = idx + marker.length;
        }
        return null;
    };

    for (const src of sources) {
        const hit = parseFromText(src);
        if (hit) return hit;
    }
    return null;
})()`;

const READ_TOKEN_STATE = `(() => {
    const input = document.querySelector('input[name="cf-turnstile-response"]')
        || document.querySelector('[name="cf-turnstile-response"]');
    const widget = document.querySelector(".cf-turnstile");
    return {
        tokenLength: input?.value?.length ?? 0,
        widgetState: widget?.getAttribute("data-state") || null,
    };
})()`;

const CLICK_CHECK = `(() => {
    const candidates = [...document.querySelectorAll("button, input[type='submit'], [role='button']")];
    const checkBtn = candidates.find((el) => /^check$/i.test(
        (el.innerText || el.textContent || el.value || "").trim()
    ));
    if (!checkBtn) return { ok: false, reason: "check_button_not_found" };
    if (checkBtn.disabled) return { ok: false, reason: "check_button_disabled" };
    checkBtn.click();
    return { ok: true };
})()`;

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function parseArgs(argv) {
    const out = {
        endpoint: process.env.VELORA_CDP || null,
        waitSeconds: 10,
        checkboxPollSeconds: 20,
        pollSeconds: 60,
        logLevel: "warn",
        output: OUTPUT_DIR,
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
            case "--wait": out.waitSeconds = Number(next()); break;
            case "--checkbox-poll": out.checkboxPollSeconds = Number(next()); break;
            case "--poll": out.pollSeconds = Number(next()); break;
            case "--log-level": out.logLevel = next(); break;
            case "--output": out.output = resolve(next()); break;
            case "--help":
                console.log("Usage: node turnstile-2captcha-demo-check.mjs [--wait <s>] [--poll <s>]");
                process.exit(0);
                break;
            default:
                if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
        }
    }
    return out;
}

/** Strict UI verify JSON — matches 2captcha demo success panel. */
export function isUiVerifySuccess(payload) {
    if (!isTurnstileVerifyShape(payload)) {
        return { ok: false, reason: "verify_json_not_found" };
    }
    if (payload.success !== true) {
        return { ok: false, reason: "success_not_true", payload };
    }
    const errors = payload["error-codes"];
    if (!Array.isArray(errors) || errors.length !== 0) {
        return { ok: false, reason: "error_codes_not_empty", payload };
    }
    if (typeof payload.challenge_ts !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(payload.challenge_ts)) {
        return { ok: false, reason: "invalid_challenge_ts", payload };
    }
    if (payload.hostname !== EXPECTED_HOSTNAME) {
        return { ok: false, reason: `hostname_not_${EXPECTED_HOSTNAME}`, payload };
    }
    if (!payload.metadata || typeof payload.metadata !== "object") {
        return { ok: false, reason: "metadata_missing", payload };
    }
    if (payload.metadata.result_with_testing_key !== true) {
        return { ok: false, reason: "metadata.result_with_testing_key_not_true", payload };
    }
    return { ok: true, payload };
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

async function waitForCdp(url, timeoutMs = 12_000) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        try {
            if ((await fetch(`${url}/json/version`)).ok) return;
        } catch { /* retry */ }
        await delay(100);
    }
    throw new Error(`CDP not ready: ${url}`);
}

async function spawnVelora(logLevel) {
    if (!existsSync(veloraBin)) {
        throw new Error(`Run zig build first — missing ${veloraBin}`);
    }
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", BROWSER_PROFILE,
        "--log-level", logLevel, "--log-format", "pretty",
    ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    const endpoint = `http://127.0.0.1:${port}`;
    await waitForCdp(endpoint);
    return { proc, endpoint };
}

async function safeEvaluate(page, expression, fallback = null) {
    try {
        return await page.evaluate(expression);
    } catch (e) {
        const msg = e?.message ?? String(e);
        if (/Promise was collected|timed out/i.test(msg)) return fallback;
        throw e;
    }
}

async function clickTurnstileCheckbox(page) {
    const box = await safeEvaluate(page, `(() => {
        const w = document.querySelector(".cf-turnstile");
        if (!w) return null;
        w.scrollIntoView({ block: "center", inline: "center" });
        const r = w.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return null;
        return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()`);
    if (!box) return { ok: false, reason: "widget_not_found" };

    const x = box.left + 28;
    const y = box.top + box.height / 2;
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await page.session.send("Input.dispatchMouseEvent", {
            type,
            x,
            y,
            button: type === "mouseMoved" ? "none" : "left",
            clickCount: type === "mousePressed" ? 1 : 0,
        });
        await delay(100);
    }
    return { ok: true, x, y };
}

function findVerifyRequest(requests) {
    for (const r of requests) {
        if (!VERIFY_URL_RE.test(r.url || "")) continue;
        if (r.method !== "POST") continue;
        return r;
    }
    return null;
}

async function readVerifyApiJson(page, request) {
    if (!request?.requestId) return null;
    const body = await page.session.send("Network.getResponseBody", {
        requestId: request.requestId,
    }).catch(() => null);
    if (!body?.body) return null;
    const text = body.base64Encoded
        ? Buffer.from(body.body, "base64").toString("utf8")
        : body.body;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    await mkdir(opts.output, { recursive: true });

    let veloraProc = null;
    let endpoint = opts.endpoint;
    const t0 = Date.now();

    if (!endpoint) {
        const spawned = await spawnVelora(opts.logLevel);
        veloraProc = spawned.proc;
        endpoint = spawned.endpoint;
        console.log(`[velora] ${endpoint}`);
    }

    const report = {
        url: TARGET_URL,
        passed: false,
        tokenLength: 0,
        widgetState: null,
        uiVerifyJson: null,
        apiVerifyJson: null,
        verifyRequest: null,
        reason: null,
        durationMs: 0,
    };

    const browser = await Browser.connect(endpoint);
    try {
        const page = await browser.newPage();
        await page.session.send("Network.enable").catch(() => {});

        console.log(`[goto] ${TARGET_URL}`);
        await page.goto(TARGET_URL, { waitUntil: "load", timeout: 90_000 });

        if (opts.waitSeconds > 0) {
            console.log(`[wait] ${opts.waitSeconds}s for Turnstile widget`);
            await delay(opts.waitSeconds * 1000);
        }

        const click = await clickTurnstileCheckbox(page);
        console.log(`[click] checkbox: ${click.ok ? `ok@${click.x?.toFixed?.(1)},${click.y?.toFixed?.(1)}` : click.reason}`);
        if (!click.ok) {
            report.reason = click.reason;
            process.exitCode = 1;
            return;
        }

        console.log(`[poll] up to ${opts.checkboxPollSeconds}s for token after checkbox`);
        const tokenPollEnd = Date.now() + opts.checkboxPollSeconds * 1000;
        while (Date.now() < tokenPollEnd) {
            const tokenState = await safeEvaluate(page, READ_TOKEN_STATE, { tokenLength: 0 });
            report.tokenLength = tokenState?.tokenLength ?? 0;
            report.widgetState = tokenState?.widgetState ?? null;
            if (report.tokenLength > 0) break;
            await delay(1500);
        }
        console.log(`[token] length=${report.tokenLength} state=${report.widgetState ?? "?"}`);

        console.log("[click] Check button");
        const check = await safeEvaluate(page, CLICK_CHECK, { ok: false, reason: "evaluate_failed" });
        if (!check.ok) {
            report.reason = `check:${check.reason}`;
            console.log(`[fail] ${report.reason}`);
            process.exitCode = 1;
            return;
        }

        console.log(`[poll] up to ${opts.pollSeconds}s for UI verify JSON`);
        const pollEnd = Date.now() + opts.pollSeconds * 1000;
        let verdict = { ok: false, reason: "timeout" };

        while (Date.now() < pollEnd) {
            const verifyReq = findVerifyRequest([...page.network.requests.values()]);
            if (verifyReq) {
                report.verifyRequest = {
                    url: verifyReq.url,
                    status: verifyReq.response?.status,
                };
                report.apiVerifyJson = await readVerifyApiJson(page, verifyReq);
            }

            report.uiVerifyJson = await safeEvaluate(page, EXTRACT_UI_VERIFY_JSON, null);
            verdict = isUiVerifySuccess(report.uiVerifyJson);
            if (verdict.ok) break;

            await delay(1500);
        }

        report.reason = verdict.ok ? null : verdict.reason;
        report.passed = verdict.ok;
        report.durationMs = Date.now() - t0;

        console.log(`\ntokenLength: ${report.tokenLength}  widgetState: ${report.widgetState ?? "?"}`);

        console.log("\n=== UI verify JSON (required) ===");
        if (report.uiVerifyJson) {
            console.log(JSON.stringify(report.uiVerifyJson, null, 2));
        } else {
            console.log("(not found on page)");
        }

        if (report.apiVerifyJson) {
            console.log("\n=== Verify API response (debug) ===");
            console.log(JSON.stringify(report.apiVerifyJson, null, 2));
        }
        if (report.verifyRequest) {
            console.log(`\nverify POST: [${report.verifyRequest.status ?? "?"}] ${report.verifyRequest.url}`);
        }

        console.log("\n=== Result ===");
        if (verdict.ok) {
            console.log("PASSED: UI shows success verify JSON");
            process.exitCode = 0;
        } else {
            console.log(`FAILED: ${verdict.reason}`);
            if (report.apiVerifyJson?.success === true && !report.uiVerifyJson) {
                console.log("(verify API succeeded but JSON not rendered in UI)");
            }
            process.exitCode = 1;
        }

        await writeFile(
            resolve(opts.output, "report.json"),
            `${JSON.stringify(report, null, 2)}\n`,
        );
        console.log(`saved: ${resolve(opts.output, "report.json")}`);
    } finally {
        await browser.close().catch(() => {});
        veloraProc?.kill("SIGTERM");
    }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    main().catch((err) => {
        console.error("ERROR:", err?.message ?? err);
        process.exit(1);
    });
}