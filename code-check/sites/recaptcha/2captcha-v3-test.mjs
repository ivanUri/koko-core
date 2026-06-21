#!/usr/bin/env node
// Test 2captcha reCAPTCHA v3 demo: load page, click Check, expect success message.
//
// Usage:
//   node code-check/sites/recaptcha/2captcha-v3-test.mjs
//   node code-check/sites/recaptcha/2captcha-v3-test.mjs --settle 8 --poll 30

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

const TARGET_URL = "https://2captcha.com/demo/recaptcha-v3";
const SITEKEY = "6LfB5_IbAAAAAMCtsjEHEHKqcB9iQocwwxTiihJu";
const ACTION = "demo_action";
const SUCCESS_TEXT = "Captcha is passed successfully";
const BROWSER_PROFILE = "chrome-macos-catalina";

function parseArgs(argv) {
    const out = {
        endpoint: process.env.VELORA_CDP || null,
        output: resolve(repoRoot, "code-check/tmp/2captcha-recaptcha-v3"),
        timeout: 90_000,
        settleSeconds: 5,
        pollSeconds: 30,
        maxAttempts: 3,
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
            case "--output": out.output = resolve(next()); break;
            case "--timeout": out.timeout = Number(next()); break;
            case "--settle": out.settleSeconds = Number(next()); break;
            case "--poll": out.pollSeconds = Number(next()); break;
            case "--attempts": out.maxAttempts = Number(next()); break;
            case "--help":
                console.log(
                    "Usage: node 2captcha-v3-test.mjs [--settle <s>] [--poll <s>] " +
                    "[--attempts <n>] [--endpoint <cdp>] [--output <dir>]"
                );
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

const PAGE_PROBE = `(() => {
    const body = document.body?.innerText || "";
    const buttons = [...document.querySelectorAll("button")].map((b) => ({
        text: (b.innerText || b.textContent || "").trim(),
        type: b.type || "",
        disabled: b.disabled,
        className: b.className?.slice?.(0, 80) || "",
    }));
    const alerts = [...document.querySelectorAll("[role='alert'], .alert, [class*='Alert']")]
        .map((el) => (el.innerText || el.textContent || "").trim())
        .filter(Boolean);
    return {
        title: document.title,
        url: location.href,
        bodySnippet: body.slice(0, 800),
        hasSuccessText: body.includes(${JSON.stringify(SUCCESS_TEXT)}),
        grecaptcha: typeof grecaptcha,
        verifyRecaptcha: typeof window.verifyRecaptcha,
        iframeCount: document.querySelectorAll("iframe").length,
        recaptchaIframes: [...document.querySelectorAll("iframe")]
            .map((f) => f.src || f.getAttribute("src") || "")
            .filter((s) => /recaptcha/i.test(s)),
        buttons,
        alerts,
        webdriver: navigator.webdriver,
    };
})()`;

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

const MANUAL_EXECUTE = `(async () => {
    const sitekey = ${JSON.stringify(SITEKEY)};
    const action = ${JSON.stringify(ACTION)};
    if (typeof grecaptcha === "undefined" || typeof grecaptcha.execute !== "function") {
        return { ok: false, reason: "grecaptcha_unavailable" };
    }
    const token = await grecaptcha.execute(sitekey, { action });
    if (typeof window.verifyRecaptcha === "function") {
        await window.verifyRecaptcha(token);
    }
    return {
        ok: true,
        tokenLength: token?.length ?? 0,
        tokenPreview: token?.slice(0, 12) ?? null,
        verifyCalled: typeof window.verifyRecaptcha === "function",
    };
})()`;

async function pollForSuccess(page, pollSeconds) {
    const end = Date.now() + pollSeconds * 1000;
    const snapshots = [];
    while (Date.now() < end) {
        const snap = await page.evaluate(PAGE_PROBE).catch((e) => ({
            hasSuccessText: false,
            error: String(e),
        }));
        snapshots.push({ atMs: Date.now(), ...snap });
        if (snap.hasSuccessText) return { passed: true, snap, snapshots };
        await delay(500);
    }
    const last = snapshots.at(-1) ?? {};
    return { passed: false, snap: last, snapshots };
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
        console.log(`[velora] ${endpoint} profile=${BROWSER_PROFILE}`);
    }

    const t0 = Date.now();
    const errors = [];
    const attempts = [];

    const browser = await Browser.connect(endpoint);

    try {
        const page = await browser.newPage();
        page.session.on("Runtime.exceptionThrown", (e) => {
            errors.push(e?.exceptionDetails?.text ?? "exception");
        });

        let passed = false;
        let lastSnap = null;
        let manualExecute = null;

        for (let attempt = 1; attempt <= opts.maxAttempts; attempt += 1) {
            if (attempt > 1) {
                console.log(`[retry] attempt ${attempt} — reload fresh page`);
            }
            console.log(`[goto] ${TARGET_URL}`);
            await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: opts.timeout });

            console.log(`[settle] ${opts.settleSeconds}s (grecaptcha.ready + execute)`);
            await delay(opts.settleSeconds * 1000);

            const preClick = await page.evaluate(PAGE_PROBE).catch((e) => ({
                error: String(e),
            }));
            console.log(
                `[probe] grecaptcha=${preClick.grecaptcha} verifyRecaptcha=${preClick.verifyRecaptcha} ` +
                `iframes=${preClick.iframeCount ?? "?"}`
            );

            if (preClick.hasSuccessText) {
                passed = true;
                lastSnap = preClick;
                attempts.push({ attempt, phase: "pre_click", passed: true, preClick });
                break;
            }

            console.log("[click] Check button ...");
            const clickResult = await page.evaluate(CLICK_CHECK).catch((e) => ({
                ok: false,
                reason: String(e),
            }));
            console.log(`[click] ${clickResult.ok ? `clicked "${clickResult.text}"` : clickResult.reason}`);

            let poll = await pollForSuccess(page, opts.pollSeconds);
            lastSnap = poll.snap;

            if (!poll.passed && clickResult.ok) {
                console.log("[manual] re-execute + verifyRecaptcha, then click Check again ...");
                try {
                    manualExecute = await page.evaluate(MANUAL_EXECUTE, { timeout: 45_000 });
                    console.log(
                        `[manual] token=${manualExecute?.tokenLength ?? 0} ` +
                        `preview=${manualExecute?.tokenPreview ?? "?"} ` +
                        `stub=${manualExecute?.tokenPreview?.startsWith("HF") ?? "?"}`
                    );
                    if (manualExecute?.ok) {
                        await page.evaluate(CLICK_CHECK);
                        poll = await pollForSuccess(page, opts.pollSeconds);
                        lastSnap = poll.snap;
                    }
                } catch (e) {
                    manualExecute = { ok: false, reason: String(e) };
                    console.log(`[manual] failed: ${e?.message ?? e}`);
                }
            }

            passed = poll.passed;
            attempts.push({
                attempt,
                clickResult,
                manualExecute,
                passed,
                preClick,
                pollSnapshots: poll.snapshots?.slice(-5),
                lastSnap,
            });

            if (passed) break;
        }

        const recaptchaReqs = [...page.network.requests.values()]
            .filter((r) => /recaptcha|gstatic|2captcha/i.test(r.url || ""))
            .map((r) => ({
                url: r.url,
                method: r.method,
                status: r.response?.status,
                failure: r.failureText,
            }));

        const report = {
            target: TARGET_URL,
            sitekey: SITEKEY,
            action: ACTION,
            successText: SUCCESS_TEXT,
            attempts,
            lastSnap,
            manualExecute,
            errors,
            recaptchaRequests: recaptchaReqs,
            durationMs: Date.now() - t0,
            passed,
        };

        await writeFile(resolve(opts.output, "page.html"), await page.content());
        await writeFile(resolve(opts.output, "report.json"), JSON.stringify(report, null, 2));
        if (veloraStderr.length) {
            await writeFile(resolve(opts.output, "velora.log"), Buffer.concat(veloraStderr).toString());
        }

        console.log("\n=== 2captcha reCAPTCHA v3 demo ===");
        console.log(`success:  ${passed ? "yes" : "no"}`);
        if (lastSnap?.bodySnippet) {
            const line = lastSnap.bodySnippet.split("\n").find((l) => l.includes("Captcha")) || "";
            if (line) console.log(`message:  ${line.trim()}`);
        }
        if (lastSnap?.alerts?.length) {
            console.log(`alerts:   ${lastSnap.alerts.join(" | ")}`);
        }
        console.log(`\n=== Result: ${passed ? "PASS" : "FAIL"} ===`);
        console.log(`saved: ${opts.output}/report.json`);

        await page.close().catch(() => {});
        process.exitCode = passed ? 0 : 1;
    } finally {
        await browser.close().catch(() => {});
        if (veloraProc) {
            veloraProc.kill("SIGTERM");
            await delay(300);
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});