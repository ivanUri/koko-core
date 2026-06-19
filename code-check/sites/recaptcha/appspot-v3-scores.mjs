#!/usr/bin/env node
// Test reCAPTCHA v3 on Google demo: recaptcha-v3-request-scores.php
// Same v3 flow as antcpt score_detector but different sitekey + verify endpoint.

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

const TARGET_URL = "https://recaptcha-demo.appspot.com/recaptcha-v3-request-scores.php";
const SITEKEY = "6LdKlZEpAAAAAAOQjzC2v_d36tWxCl6dWsozdSy9";
const ACTION = "examples/v3scores";
const BROWSER_PROFILE = "chrome-macos-catalina";

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
    const step = (n) => {
        const el = document.querySelector('.step' + n);
        return el && !el.classList.contains('hidden');
    };
    const tokenPre = document.querySelector('.token')?.textContent?.trim() || "";
    const responsePre = document.querySelector('.response')?.textContent?.trim() || "";
    let responseJson = null;
    let score = null;
    let success = null;
    let errorCodes = null;
    try {
        responseJson = JSON.parse(responsePre);
        score = responseJson?.score ?? null;
        success = responseJson?.success ?? null;
        errorCodes = responseJson?.["error-codes"] ?? null;
    } catch (_) {}

    const tokenMatch = tokenPre.match(/token='([^']+)/);
    const tokenPreview = tokenMatch?.[1]?.slice(0, 8) || null;

    let state = "step0_loading";
    if (step(3)) state = success === true && score != null ? "scored" : "verify_error";
    else if (step(2)) state = "token_received";
    else if (step(1)) state = "executing";
    else if (step(0)) state = "loading";

    return {
        title: document.title,
        url: location.href,
        state,
        steps: { s0: step(0), s1: step(1), s2: step(2), s3: step(3) },
        tokenPreview,
        tokenLength: tokenMatch?.[1]?.length ?? 0,
        responsePre: responsePre.slice(0, 500),
        score,
        success,
        errorCodes,
        grecaptcha: typeof grecaptcha,
        recaptchaScript: !!document.querySelector('script[src*="recaptcha/api.js"]'),
        iframeCount: document.querySelectorAll("iframe").length,
        webdriver: navigator.webdriver,
    };
})()`;

const MANUAL_VERIFY = `(async () => {
    const sitekey = ${JSON.stringify(SITEKEY)};
    const action = ${JSON.stringify(ACTION)};
    if (typeof grecaptcha === "undefined" || typeof grecaptcha.execute !== "function") {
        return { ok: false, reason: "grecaptcha_unavailable" };
    }
    const token = await grecaptcha.execute(sitekey, { action });
    const url = '/recaptcha-v3-verify.php?action=' + encodeURIComponent(action) + '&token=' + encodeURIComponent(token);
    const resp = await fetch(url);
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return {
        ok: json?.success === true && json?.score != null,
        tokenLength: token?.length ?? 0,
        tokenPreview: token?.slice(0, 12) ?? null,
        verifyStatus: resp.status,
        verifyBody: json ?? text.slice(0, 500),
        score: json?.score ?? null,
        errorCodes: json?.["error-codes"] ?? null,
    };
})()`;

async function main() {
    const output = resolve(repoRoot, "code-check/tmp/recaptcha-appspot");
    await mkdir(output, { recursive: true });

    const { proc, endpoint, stderr } = await spawnVelora();
    console.log(`[velora] ${endpoint} profile=${BROWSER_PROFILE}`);

    const browser = await Browser.connect(endpoint);
    const errors = [];
    const probes = [];
    const t0 = Date.now();

    try {
        const page = await browser.newPage();
        page.session.on("Runtime.exceptionThrown", (e) => {
            errors.push(e?.exceptionDetails?.text ?? "exception");
        });

        let last = {};
        let manualVerify = null;

        // appspot gọi execute() ngay trong grecaptcha.ready() — race với enterprise.js (GTM).
        // Auto-flow treo; đợi lâu trên cùng page → stub token (HF..., 640 chars).
        // Retry với page mới: settle 5s rồi execute ngay (không poll thêm).
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            if (attempt > 1) {
                console.log(`[retry] attempt ${attempt} — reload fresh page`);
                await page.goto(TARGET_URL, { waitUntil: "load", timeout: 90_000 });
            } else {
                console.log(`[goto] ${TARGET_URL}`);
                await page.goto(TARGET_URL, { waitUntil: "load", timeout: 90_000 });
            }

            const settleMs = 5000;
            console.log(`[settle] ${settleMs}ms (enterprise.js + anchor)`);
            await delay(settleMs);

            const atMs = Date.now() - t0;
            const snap = await page.evaluate(PAGE_PROBE).catch((e) => ({
                state: "eval_error", error: String(e),
            }));
            probes.push({ atMs, attempt, ...snap });
            last = snap;
            console.log(
                `[probe +${atMs}ms] attempt=${attempt} auto-flow=${snap.state} steps=${JSON.stringify(snap.steps)}`
            );

            console.log("[manual] grecaptcha.execute + verify ...");
            try {
                manualVerify = await page.evaluate(MANUAL_VERIFY, { timeout: 45_000 });
                console.log(
                    `[manual] token=${manualVerify?.tokenLength ?? 0} preview=${manualVerify?.tokenPreview ?? "?"} ` +
                    `score=${manualVerify?.score ?? "none"} ` +
                    `stub=${manualVerify?.tokenPreview?.startsWith("HF") ?? "?"} ` +
                    `errors=${(manualVerify?.errorCodes || []).join(",") || "none"}`
                );
            } catch (e) {
                manualVerify = { ok: false, reason: String(e) };
                console.log(`[manual] failed: ${e?.message ?? e}`);
            }

            if (manualVerify?.ok && manualVerify?.score != null) break;
        }

        const recaptchaReqs = [...page.network.requests.values()]
            .filter((r) => /recaptcha|gstatic|recaptcha-v3-verify/i.test(r.url || ""))
            .map((r) => ({
                url: r.url,
                method: r.method,
                status: r.response?.status,
                failure: r.failureText,
            }));

        const finalScore = last.score ?? manualVerify?.score ?? null;
        const passed = finalScore != null && finalScore >= 0.7;
        const verifyErrors = last.errorCodes || manualVerify?.errorCodes || [];
        const autoFlowBroken = last.steps?.s1 && !last.steps?.s2;

        const report = {
            target: TARGET_URL,
            sitekey: SITEKEY,
            action: ACTION,
            probes,
            last,
            manualVerify,
            errors,
            recaptchaRequests: recaptchaReqs,
            durationMs: Date.now() - t0,
            score: finalScore,
            passed,
            verifyErrors,
        };

        await writeFile(resolve(output, "page.html"), await page.content());
        await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
        if (stderr.length) {
            await writeFile(resolve(output, "velora.log"), Buffer.concat(stderr).toString());
        }

        console.log("\n=== reCAPTCHA v3 score (appspot demo) ===");
        console.log(`score:    ${finalScore ?? "none"}`);
        console.log(`response: ${last.responsePre || JSON.stringify(manualVerify?.verifyBody) || "(empty)"}`);
        if (verifyErrors.length) console.log(`errors:   ${verifyErrors.join(", ")}`);
        if (manualVerify?.tokenPreview) {
            console.log(`token:    ${manualVerify.tokenPreview}... (${manualVerify.tokenLength} chars)`);
        }
        if (autoFlowBroken && passed) {
            console.log("note:     page auto-flow treo (ready→execute race với GTM enterprise.js); manual sau 5s OK");
        } else if (manualVerify?.tokenPreview?.startsWith("HF")) {
            console.log("note:     stub token HF... = execute quá sớm hoặc page đã bị poison sau auto-flow treo");
        }
        console.log(`\n=== Result: ${passed ? "PASS" : verifyErrors.length ? "VERIFY_FAIL" : "FAIL"} ===`);
        console.log(`saved: ${output}/report.json`);

        await page.close().catch(() => {});
        process.exitCode = passed ? 0 : 1;
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
        await delay(300);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});