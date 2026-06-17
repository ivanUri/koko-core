#!/usr/bin/env node
// Diagnose 2captcha reCAPTCHA v2 via Velora core (velora fetch), no CDP/MCP.
//
// Usage:
//   node code-check/2captcha-recaptcha-v2-core.mjs
//   node code-check/2captcha-recaptcha-v2-core.mjs --profile velora
//   node code-check/2captcha-recaptcha-v2-core.mjs --all-profiles
//   node code-check/2captcha-recaptcha-v2-core.mjs --skip-core-click --wait-ms 60000

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const diagScript = resolve(__dirname, "2captcha-recaptcha-v2-core.js");

const TARGET_URL = "https://2captcha.com/demo/recaptcha-v2";
const PROFILES = ["velora", "chrome-macos-catalina"];
const DEFAULT_PROFILE = "chrome-macos-catalina";
const IFRAME_SELECTOR = 'iframe[src*="recaptcha"]';

function parseArgs(argv) {
    const out = {
        output: resolve(repoRoot, "code-check/tmp/2captcha-recaptcha-v2-core"),
        waitMs: 120_000,
        skipCoreClick: false,
        logLevel: "info",
        profiles: [DEFAULT_PROFILE],
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
            i += 1;
            return argv[i];
        };
        switch (a) {
            case "--output": out.output = resolve(next()); break;
            case "--wait-ms": out.waitMs = Number(next()); break;
            case "--skip-core-click": out.skipCoreClick = true; break;
            case "--log-level": out.logLevel = next(); break;
            case "--profile": {
                const p = next();
                if (!PROFILES.includes(p)) {
                    throw new Error(`Unknown profile "${p}". Available: ${PROFILES.join(", ")}`);
                }
                out.profiles = [p];
                break;
            }
            case "--all-profiles": out.profiles = [...PROFILES]; break;
            case "--help":
                console.log(`Usage: node 2captcha-recaptcha-v2-core.mjs [options]
  --output DIR         report directory
  --wait-ms MS         wait-script timeout (default 120000)
  --profile NAME       browser profile: velora | chrome-macos-catalina (default: ${DEFAULT_PROFILE})
  --all-profiles       run probe (+ optional core click) for every built-in profile
  --skip-core-click    only run DOM/JS probe, skip core triggerMouseClick
  --log-level LEVEL    velora log level (default info)
`);
                process.exit(0);
                break;
            default:
                if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
        }
    }
    return out;
}

function extractDiagFromHtml(html) {
    const m = html.match(/<pre[^>]*id="velora-diag-report"[^>]*>([\s\S]*?)<\/pre>/i);
    if (!m) return null;
    const text = m[1]
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .trim();
    const marker = "VELORA_DIAG:";
    const idx = text.indexOf(marker);
    if (idx < 0) return null;
    return JSON.parse(text.slice(idx + marker.length));
}

function extractDiag(stderr) {
    const marker = "VELORA_DIAG:";
    const hits = [];
    let idx = 0;
    while (idx < stderr.length) {
        const at = stderr.indexOf(marker, idx);
        if (at < 0) break;
        let jsonStart = at + marker.length;
        while (jsonStart < stderr.length && /\s/.test(stderr[jsonStart])) jsonStart += 1;
        let depth = 0;
        let end = -1;
        for (let i = jsonStart; i < stderr.length; i += 1) {
            const ch = stderr[i];
            if (ch === "{") depth += 1;
            else if (ch === "}") {
                depth -= 1;
                if (depth === 0) {
                    end = i + 1;
                    break;
                }
            }
        }
        if (end > jsonStart) hits.push(stderr.slice(jsonStart, end));
        idx = at + marker.length;
    }
    if (!hits.length) return null;
    return JSON.parse(hits[hits.length - 1]);
}

function runVeloraFetch(args, env = {}) {
    return new Promise((resolve, reject) => {
        const stderrChunks = [];
        const stdoutChunks = [];
        const proc = spawn(veloraBin, args, {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, ...env },
        });
        proc.stdout.on("data", (c) => stdoutChunks.push(c));
        proc.stderr.on("data", (c) => stderrChunks.push(c));
        proc.on("error", reject);
        proc.on("close", (code) => {
            resolve({
                code: code ?? 1,
                stdout: Buffer.concat(stdoutChunks).toString(),
                stderr: Buffer.concat(stderrChunks).toString(),
            });
        });
    });
}

async function writeModeScript(mode, outDir) {
    const base = await readFile(diagScript, "utf8");
    const path = resolve(outDir, `diag-${mode}.js`);
    await writeFile(path, `globalThis.__veloraDiagMode = ${JSON.stringify(mode)};\n${base}`);
    return path;
}

function baseFetchArgs(opts, scriptPath, profile) {
    const args = [
        "fetch",
        TARGET_URL,
        "--log-level", opts.logLevel,
        "--wait-until", "load",
        "--wait-ms", String(opts.waitMs),
        "--wait-script-file", scriptPath,
        "--dump", "html",
        "--insecure-disable-tls-host-verification",
    ];
    if (profile !== "velora") {
        args.push("--browser-profile", profile);
    }
    return args;
}

async function runProbe(opts, scriptPath, profile) {
    console.log(`\n=== [${profile}] JS/DOM probe (core fetch, no click) ===`);
    const args = baseFetchArgs(opts, scriptPath, profile);
    const res = await runVeloraFetch(args);
    const diag = extractDiagFromHtml(res.stdout) || extractDiag(res.stderr);
    return { profile, label: "probe", exitCode: res.code, diag, stderr: res.stderr, stdout: res.stdout };
}

async function runCoreClick(opts, scriptPath, profile) {
    console.log(`\n=== [${profile}] Core triggerMouseClick via fetch --click-selector ===`);
    const args = [
        ...baseFetchArgs(opts, scriptPath, profile),
        "--wait-selector", IFRAME_SELECTOR,
        "--click-selector", IFRAME_SELECTOR,
        "--click-offset-x", "28",
    ];
    const res = await runVeloraFetch(args);
    const diag = extractDiagFromHtml(res.stdout) || extractDiag(res.stderr);
    return { profile, label: "core_click", exitCode: res.code, diag, stderr: res.stderr, stdout: res.stdout };
}

function printSummary(report) {
    console.log("\n=== Summary ===");
    for (const run of report.runs) {
        console.log(`\n[${run.profile} / ${run.label}] exit=${run.exitCode}`);
        if (!run.diag) {
            console.log("  (no VELORA_DIAG output — check velora stderr in report.json)");
            continue;
        }
        const d = run.diag;
        console.log(`  verdict: ${d.verdict}`);
        console.log(`  grecaptcha: ${d.grecaptcha}, iframes: ${d.recaptchaIframeCount}`);
        if (d.iframe) {
            const r = d.iframe.rect;
            console.log(`  iframe: ${r.width.toFixed(0)}x${r.height.toFixed(0)} at (${r.left.toFixed(0)},${r.top.toFixed(0)})`);
        }
        if (d.hitTest) {
            console.log(`  elementFromPoint → ${d.hitTest.topElement?.tag || "?"} (hitsIframe=${d.hitTest.hitsIframe})`);
            console.log(`  click coords: (${d.hitTest.clickX?.toFixed?.(1)}, ${d.hitTest.clickY?.toFixed?.(1)})`);
        }
        if (d.tokenAfterDomClick) {
            console.log(`  token length: ${d.tokenAfterDomClick.length}`);
        }
        if (d.rootCauses?.length) {
            console.log("  root causes:");
            for (const c of d.rootCauses) {
                console.log(`    - [${c.id}] ${c.detail}`);
            }
        }
    }

    console.log("\n=== Likely fix direction ===");
    const causes = new Set(report.runs.flatMap((r) => (r.diag?.rootCauses || []).map((c) => c.id)));
    if (causes.has("core_click_no_token")) {
        console.log("  Core click pierces iframe but token/challenge still missing — check child-frame hit target or event sequence.");
    }
    if (causes.has("dom_click_on_iframe_ineffective")) {
        console.log("  DOM probe clicks iframe element only; use core triggerMouseClick for pierced input routing.");
    }
    if (causes.has("widget_not_loaded") || causes.has("widget_not_rendered")) {
        console.log("  Widget render: fix grecaptcha.render / SPA mount before testing iframe click routing.");
    }
    if (causes.has("grecaptcha_render_broken")) {
        console.log("  grecaptcha API: render() missing or broken in Velora — blocks any click test on this page.");
    }
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    await mkdir(opts.output, { recursive: true });

    if (!existsSync(veloraBin)) {
        throw new Error(`Velora binary not found at ${veloraBin}. Run \`zig build\` first.`);
    }
    if (!existsSync(diagScript)) {
        throw new Error(`Diagnostic script missing: ${diagScript}`);
    }

    const t0 = Date.now();
    const runs = [];

    const probeScript = await writeModeScript("probe", opts.output);
    const coreScript = await writeModeScript("core_click", opts.output);

    for (const profile of opts.profiles) {
        runs.push(await runProbe(opts, probeScript, profile));
        if (!opts.skipCoreClick) {
            runs.push(await runCoreClick(opts, coreScript, profile));
        }
    }

    const report = {
        url: TARGET_URL,
        profiles: opts.profiles,
        durationMs: Date.now() - t0,
        runs,
    };

    await writeFile(resolve(opts.output, "report.json"), JSON.stringify(report, null, 2));
    for (const run of runs) {
        await writeFile(
            resolve(opts.output, `${run.profile}-${run.label}.stderr.log`),
            run.stderr,
        );
    }

    printSummary(report);
    console.log(`\nsaved: ${opts.output}/report.json`);

    const passed = runs.some((r) => r.diag?.verdict === "token_received");
    process.exitCode = passed ? 0 : 1;
}

main().catch((err) => {
    console.error("FAILED:", err?.stack || err?.message || err);
    process.exit(1);
});