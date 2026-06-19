#!/usr/bin/env node
// Đo reCAPTCHA v3 score qua https://antcpt.com/score_detector/ (AntiCaptcha).
//
// Trang tự gọi grecaptcha.execute() rồi POST token lên verify.php để lấy score 0.0–1.0.
// Score cao (>= 0.7) ≈ Google coi là human; thấp (< 0.3) ≈ bot.
//
// Usage:
//   node code-check/sites/recaptcha/score-detector.mjs
//   node code-check/sites/recaptcha/score-detector.mjs --min-score 0.7
//   node code-check/sites/recaptcha/score-detector.mjs --poll 60 --manual-verify

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

const TARGET_URL = "https://antcpt.com/score_detector/";
const SITEKEY = "6LcR_okUAAAAAPYrPe-HK_0RULO1aZM15ENyM-Mf";
const BROWSER_PROFILE = "chrome-macos-catalina";

function parseArgs(argv) {
    const out = {
        endpoint: process.env.VELORA_CDP || null,
        output: resolve(repoRoot, "code-check/tmp/recaptcha-score"),
        timeout: 90_000,
        settleSeconds: 5,
        pollSeconds: 60,
        minScore: null,
        manualVerify: false,
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
            case "--min-score": out.minScore = Number(next()); break;
            case "--manual-verify": out.manualVerify = true; break;
            case "--help":
                console.log(
                    "Usage: node score-detector.mjs [--min-score <0-1>] [--poll <s>] " +
                    "[--settle <s>] [--manual-verify] [--endpoint <cdp>] [--output <dir>]"
                );
                process.exit(0);
                break;
            default:
                if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
        }
    }
    if (out.minScore !== null && (out.minScore < 0 || out.minScore > 1)) {
        throw new Error("--min-score must be between 0 and 1");
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
    const plugins = navigator.plugins;
    const pluginInfo = plugins ? {
        tag: Object.prototype.toString.call(plugins),
        length: plugins.length,
        sameAsNavigator: plugins === navigator,
        names: [...plugins].map((p) => p.name),
    } : null;

    const paragraphs = [...document.querySelectorAll("p")].map((p) => p.innerText.trim());
    const statusMessage = paragraphs.find((t) =>
        /detecting score|your score is|error occurred|will be shown here/i.test(t)
    ) || "";

    let score = null;
    const scoreMatch = statusMessage.match(/your score is:\\s*([0-9.]+)/i);
    if (scoreMatch) score = Number(scoreMatch[1]);

    const suggestion = paragraphs.find((t) =>
        /easy|hard|human|bot|recommend|likely/i.test(t) &&
        !/score shows|taken by solving/i.test(t)
    ) || "";

    const infoBlock = paragraphs.find((t) => /current user agent/i.test(t)) || "";
    const ua = infoBlock.match(/Current User Agent:\\s*([^\\n]+)/i)?.[1]?.trim() || null;
    const ip = infoBlock.match(/Current IP Address:\\s*([^\\n]+)/i)?.[1]?.trim() || null;

    let state = "initial";
    if (/detecting score/i.test(statusMessage)) state = "detecting";
    else if (/your score is/i.test(statusMessage)) state = "scored";
    else if (/error occurred/i.test(statusMessage)) state = "error";
    else if (/will be shown here/i.test(statusMessage)) state = "waiting";

    const safeType = (name) => {
        try { return typeof globalThis[name]; } catch { return "error"; }
    };

    return {
        title: document.title || "",
        url: location.href,
        state,
        statusMessage,
        score,
        suggestion,
        ua,
        ip,
        webdriver: navigator.webdriver,
        pluginInfo,
        chrome: window.chrome ? {
            loadTimes: typeof chrome.loadTimes,
            csi: typeof chrome.csi,
            runtime: !!chrome.runtime,
        } : null,
        grecaptcha: safeType("grecaptcha"),
        recaptchaScript: !!document.querySelector('script[src*="recaptcha/api.js"]'),
        iframeCount: document.querySelectorAll("iframe").length,
    };
})()`;

const MANUAL_VERIFY = `(async () => {
    const sitekey = ${JSON.stringify(SITEKEY)};
    if (typeof grecaptcha === "undefined" || typeof grecaptcha.execute !== "function") {
        return { ok: false, reason: "grecaptcha_unavailable" };
    }
    const token = await grecaptcha.execute(sitekey, { action: "homepage" });
    const resp = await fetch("verify.php", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ "g-recaptcha-response": token }),
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    const score = typeof json?.score !== "undefined" ? Number(json.score) : null;
    return {
        ok: json?.success === true && score !== null && !Number.isNaN(score),
        tokenLength: token?.length ?? 0,
        verifyStatus: resp.status,
        verifyBody: json ?? text.slice(0, 500),
        score,
        errorCodes: json?.["error-codes"] ?? null,
    };
})()`;

function scoreTier(score) {
    if (score === null || Number.isNaN(score)) return "unknown";
    if (score >= 0.7) return "high";
    if (score >= 0.3) return "medium";
    return "low";
}

function tierLabel(tier) {
    switch (tier) {
        case "high": return ">= 0.7 human-like (captcha dễ)";
        case "medium": return "0.3–0.7 trung bình";
        case "low": return "< 0.3 bot-like (captcha khó)";
        default: return "chưa đo được";
    }
}

function classify(last, manualVerify, minScore) {
    const score = last.score ?? manualVerify?.score ?? null;
    const tier = scoreTier(score);
    const verifyErrors = manualVerify?.errorCodes || manualVerify?.verifyBody?.["error-codes"] || [];

    let passed = false;
    let partial = false;
    let summary = "";

    if (score !== null && !Number.isNaN(score)) {
        passed = minScore === null || score >= minScore;
        partial = minScore !== null && score < minScore;
        summary = `reCAPTCHA v3 score ${score} (${tier})`;
    } else if (last.state === "error" || verifyErrors.length > 0) {
        partial = true;
        const codes = verifyErrors.length ? verifyErrors.join(", ") : "verify_failed";
        summary = `Google verify từ chối token (${codes})`;
        if (manualVerify?.tokenLength > 0) {
            summary += `; token=${manualVerify.tokenLength} chars`;
        }
    } else if (last.state === "detecting") {
        partial = true;
        summary = "vẫn đang Detecting score... (timeout)";
    } else if (manualVerify?.tokenLength > 0) {
        partial = true;
        summary = `có token (${manualVerify.tokenLength} chars) nhưng không lấy được score`;
    } else {
        summary = "không hoàn tất kiểm tra score";
    }

    return { passed, partial, score, tier, summary, verifyErrors };
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

        console.log(`[goto] ${TARGET_URL}`);
        await page.goto(TARGET_URL, { waitUntil: "load", timeout: opts.timeout });
        await delay(opts.settleSeconds * 1000);

        const pollEnd = Date.now() + opts.pollSeconds * 1000;
        while (Date.now() < pollEnd) {
            const atMs = Date.now() - t0;
            const snap = await page.evaluate(PAGE_PROBE).catch((e) => ({
                state: "eval_error",
                error: String(e),
            }));
            probes.push({ atMs, ...snap });
            console.log(
                `[probe +${atMs}ms] state=${snap.state} score=${snap.score ?? "?"} ` +
                `grecaptcha=${snap.grecaptcha ?? "?"}`
            );
            if (snap.state === "scored" || snap.state === "error") break;
            await delay(2500);
        }

        const last = probes.at(-1) || {};
        let manualVerify = null;

        const needManual =
            opts.manualVerify ||
            last.state === "error" ||
            (last.state !== "scored" && last.grecaptcha === "object");

        if (needManual) {
            console.log("[manual] grecaptcha.execute + verify.php ...");
            try {
                manualVerify = await page.evaluate(MANUAL_VERIFY, { timeout: 90_000 });
                console.log(
                    `[manual] token=${manualVerify?.tokenLength ?? 0} ` +
                    `verify=${manualVerify?.verifyStatus ?? "?"} ` +
                    `score=${manualVerify?.score ?? "none"} ` +
                    `errors=${(manualVerify?.errorCodes || []).join(",") || "none"}`
                );
            } catch (e) {
                manualVerify = { ok: false, reason: String(e) };
                console.log(`[manual] failed: ${e?.message ?? e}`);
            }
        }

        const verdict = classify(last, manualVerify, opts.minScore);
        const finalScore = verdict.score;
        const html = await page.content();

        const recaptchaReqs = [...page.network.requests.values()]
            .filter((r) => /recaptcha|gstatic|verify\\.php/i.test(r.url || ""))
            .map((r) => ({
                url: r.url,
                method: r.method,
                status: r.response?.status,
                failure: r.failureText,
            }));

        const report = {
            target: TARGET_URL,
            profile: BROWSER_PROFILE,
            sitekey: SITEKEY,
            probes,
            last,
            manualVerify,
            errors,
            recaptchaRequests: recaptchaReqs,
            durationMs: Date.now() - t0,
            score: finalScore,
            tier: verdict.tier,
            tierLabel: tierLabel(verdict.tier),
            minScore: opts.minScore,
            passed: verdict.passed,
            partial: verdict.partial,
            verifyErrors: verdict.verifyErrors,
            summary: verdict.summary,
        };

        await writeFile(resolve(opts.output, "page.html"), html);
        await writeFile(resolve(opts.output, "report.json"), JSON.stringify(report, null, 2));
        if (stderr.length) {
            await writeFile(resolve(opts.output, "velora.log"), Buffer.concat(stderr).toString());
        }

        console.log("\n=== reCAPTCHA v3 score (antcpt) ===");
        console.log(`url:      ${last.url || TARGET_URL}`);
        console.log(`ua:       ${last.ua || "(unknown)"}`);
        console.log(`ip:       ${last.ip || "(unknown)"}`);
        console.log(`webdriver: ${last.webdriver}`);
        if (last.pluginInfo) {
            const okPlugins =
                !last.pluginInfo.sameAsNavigator &&
                last.pluginInfo.tag === "[object PluginArray]" &&
                last.pluginInfo.length > 0;
            console.log(
                `plugins:  ${okPlugins ? "ok" : "BAD"} ` +
                `tag=${last.pluginInfo.tag} len=${last.pluginInfo.length} ` +
                `sameAsNav=${last.pluginInfo.sameAsNavigator}`
            );
        }
        if (last.chrome) {
            console.log(
                `chrome:   loadTimes=${last.chrome.loadTimes} csi=${last.chrome.csi} runtime=${last.chrome.runtime}`
            );
        }
        if (finalScore !== null) {
            console.log(`score:    ${finalScore} (${(finalScore * 100).toFixed(0)}%)`);
            console.log(`tier:     ${verdict.tier} — ${tierLabel(verdict.tier)}`);
        } else {
            console.log(`status:   ${last.statusMessage || last.state}`);
            if (verdict.verifyErrors?.length) {
                console.log(`verify:   ${verdict.verifyErrors.join(", ")}`);
            }
            if (manualVerify?.tokenLength) {
                console.log(`token:    ${manualVerify.tokenLength} chars`);
            }
            if (verdict.verifyErrors?.includes("browser-error")) {
                console.log("note:     Chrome thật trên cùng máy đạt ~0.9; browser-error = Google từ chối token từ môi trường Velora");
            }
        }
        if (last.suggestion) console.log(`hint:     ${last.suggestion}`);
        if (opts.minScore !== null) {
            console.log(`minScore: ${opts.minScore} → ${verdict.passed ? "PASS" : "BELOW"}`);
        }

        const label = verdict.passed ? "PASS" : verdict.partial ? "PARTIAL" : "FAIL";
        console.log(`\n=== Result: ${label} — ${verdict.summary} ===`);
        console.log(`saved: ${opts.output}/report.json`);

        await page.close().catch(() => {});
        process.exitCode = verdict.passed ? 0 : verdict.partial ? 1 : 2;
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