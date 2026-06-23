#!/usr/bin/env node
/**
 * 2captcha Turnstile demo check — raw CDP via zig-out/bin/velora (no SDK).
 *
 * PASS when UI shows verify JSON:
 *   success: true, error-codes: [], challenge_ts, hostname: "example.com",
 *   metadata.result_with_testing_key: true
 *
 * Usage:
 *   node code-check/sites/recaptcha/turnstile-2captcha-cdp-check.mjs
 *   node code-check/sites/recaptcha/turnstile-2captcha-cdp-check.mjs --log-level info
 */

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CdpClient, connectCdp, evaluate, openPage } from "./cdp-client.mjs";
import { isUiVerifySuccess } from "./turnstile-2captcha-demo-check.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const OUTPUT_DIR = resolve(repoRoot, "code-check/tmp/turnstile-2captcha-cdp");

const TARGET_URL = "https://2captcha.com/demo/cloudflare-turnstile";
const BROWSER_PROFILE = "chrome-macos-catalina";
const VERIFY_URL_RE = /captcha-demo\/cloudflare-turnstile\/verify/;

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
        if (text && typeof text === "string" && text.includes("challenge_ts")) sources.push(text);
    };
    for (const el of document.querySelectorAll("pre, code, textarea, output, [class*='result'], [class*='response']")) {
        push(el.innerText || el.textContent || "");
        push(el.value || "");
    }
    push(document.body?.innerText || "");
    const marker = '"challenge_ts"';
    for (const text of sources) {
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
                        } catch { /* next */ }
                        break;
                    }
                }
            }
            from = idx + marker.length;
        }
    }
    return null;
})()`;

const CLICK_CHECK = `(() => {
    const checkBtn = [...document.querySelectorAll("button, input[type='submit'], [role='button']")]
        .find((el) => /^check$/i.test((el.innerText || el.textContent || el.value || "").trim()));
    if (!checkBtn) return { ok: false, reason: "check_button_not_found" };
    if (checkBtn.disabled) return { ok: false, reason: "check_button_disabled" };
    checkBtn.click();
    return { ok: true };
})()`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = {
        endpoint: process.env.VELORA_CDP || null,
        waitSeconds: 10,
        checkboxPollSeconds: 25,
        pollSeconds: 60,
        logLevel: "info",
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
                console.log("Usage: node turnstile-2captcha-cdp-check.mjs [--log-level info]");
                process.exit(0);
                break;
            default:
                if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
        }
    }
    return out;
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
    if (!existsSync(veloraBin)) throw new Error(`Run zig build first — missing ${veloraBin}`);
    const port = await getFreePort();
    const stderr = [];
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", BROWSER_PROFILE,
        "--log-level", logLevel, "--log-format", "pretty",
    ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", (c) => stderr.push(c));
    const endpoint = `http://127.0.0.1:${port}`;
    await waitForCdp(endpoint);
    return { proc, endpoint, stderr };
}

async function clickTurnstileCheckbox(client, sessionId) {
    const box = await evaluate(client, sessionId, `(() => {
        const w = document.querySelector(".cf-turnstile");
        if (!w) return null;
        w.scrollIntoView({ block: "center", inline: "center" });
        const r = w.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return null;
        return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()`);
    if (!box) return { ok: false, reason: "widget_not_found" };

    // Checkbox is on the left edge; x+28 often hits the Cloudflare logo svg.
    const x = box.left + 14;
    const y = box.top + box.height / 2;
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await client.send("Input.dispatchMouseEvent", {
            type,
            x,
            y,
            button: type === "mouseMoved" ? "none" : "left",
            clickCount: type === "mousePressed" ? 1 : 0,
        }, sessionId);
        await delay(120);
    }
    return { ok: true, x, y };
}

function activationLines(stderrChunks) {
    return Buffer.concat(stderrChunks).toString("utf8")
        .split("\n")
        .filter((l) => /input activation/i.test(l));
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    await mkdir(opts.output, { recursive: true });

    let veloraProc = null;
    let stderrChunks = [];
    let endpoint = opts.endpoint;
    const t0 = Date.now();

    if (!endpoint) {
        const spawned = await spawnVelora(opts.logLevel);
        veloraProc = spawned.proc;
        endpoint = spawned.endpoint;
        stderrChunks = spawned.stderr;
        console.log(`[velora] ${endpoint} (cdp direct, no SDK)`);
    }

    const report = {
        url: TARGET_URL,
        passed: false,
        tokenLength: 0,
        widgetState: null,
        uiVerifyJson: null,
        activations: [],
        reason: null,
        durationMs: 0,
    };

    const client = await connectCdp(endpoint);
    let sessionId = null;

    try {
        const page = await openPage(client, TARGET_URL);
        sessionId = page.sessionId;

        if (opts.waitSeconds > 0) {
            console.log(`[wait] ${opts.waitSeconds}s for Turnstile widget`);
            await delay(opts.waitSeconds * 1000);
        }

        const click = await clickTurnstileCheckbox(client, sessionId);
        console.log(`[click] checkbox: ${click.ok ? `ok@${click.x?.toFixed?.(1)},${click.y?.toFixed?.(1)}` : click.reason}`);
        if (!click.ok) {
            report.reason = click.reason;
            process.exitCode = 1;
            return;
        }

        console.log("[wait] 8s for scheduler + turnstile after checkbox");
        await delay(8000);
        report.activations = activationLines(stderrChunks);
        if (report.activations.length) {
            console.log("--- input activations ---");
            for (const l of report.activations) console.log(l.trim().slice(0, 300));
        } else {
            console.log("--- input activations: (none) ---");
        }

        const tokenPollEnd = Date.now() + opts.checkboxPollSeconds * 1000;
        while (Date.now() < tokenPollEnd) {
            const st = await evaluate(client, sessionId, `(() => {
                const input = document.querySelector('[name="cf-turnstile-response"]');
                const widget = document.querySelector(".cf-turnstile");
                return {
                    tokenLength: input?.value?.length ?? 0,
                    widgetState: widget?.getAttribute("data-state") ?? null,
                };
            })()`).catch(() => ({ tokenLength: 0 }));
            report.tokenLength = st?.tokenLength ?? 0;
            report.widgetState = st?.widgetState ?? null;
            if (report.tokenLength > 0) break;
            await delay(1500);
        }
        console.log(`[token] length=${report.tokenLength} state=${report.widgetState ?? "?"}`);

        const check = await evaluate(client, sessionId, CLICK_CHECK).catch((e) => ({
            ok: false,
            reason: String(e),
        }));
        if (!check.ok) {
            report.reason = `check:${check.reason}`;
            console.log(`[fail] ${report.reason}`);
            process.exitCode = 1;
            return;
        }
        console.log("[click] Check button");

        const pollEnd = Date.now() + opts.pollSeconds * 1000;
        let verdict = { ok: false, reason: "timeout" };
        while (Date.now() < pollEnd) {
            report.uiVerifyJson = await evaluate(client, sessionId, EXTRACT_UI_VERIFY_JSON).catch(() => null);
            verdict = isUiVerifySuccess(report.uiVerifyJson);
            if (verdict.ok) break;
            await delay(1500);
        }

        report.reason = verdict.ok ? null : verdict.reason;
        report.passed = verdict.ok;
        report.durationMs = Date.now() - t0;

        console.log("\n=== UI verify JSON (required) ===");
        console.log(report.uiVerifyJson ? JSON.stringify(report.uiVerifyJson, null, 2) : "(not found)");

        console.log("\n=== Result ===");
        if (verdict.ok) {
            console.log("PASSED");
            process.exitCode = 0;
        } else {
            console.log(`FAILED: ${verdict.reason}`);
            process.exitCode = 1;
        }

        await writeFile(resolve(opts.output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
        console.log(`saved: ${resolve(opts.output, "report.json")}`);
    } finally {
        client.ws.close();
        veloraProc?.kill("SIGTERM");
    }
}

main().catch((err) => {
    console.error("ERROR:", err?.message ?? err);
    process.exit(1);
});