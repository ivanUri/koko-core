#!/usr/bin/env node
// Mở https://www.google.com qua Velora CDP + SDK, kiểm tra:
//   - load thành công, nhận đúng title
//   - DOM có các phần tử cốt lõi (form search, input name=q, button)
//   - không có JS exception, không có request bị fail
//   - dump HTML rút gọn + JSON report
//
// Chạy:
//   node code-check/google-test.mjs
//   node code-check/google-test.mjs --query "velora browser" --wait 5
//
// Tuỳ chọn:
//   --endpoint <url>  dùng velora đang chạy sẵn (bỏ qua spawn)
//   --keep            không kill velora khi xong
//   --query <text>    nếu set, sẽ thử submit search và đọc kết quả
//   --output <dir>    thư mục lưu html/report (default code-check/tmp/google)
//   --timeout <ms>    navigation timeout (default 60000)
//   --wait <s>        idle thêm n giây sau load (default 3)

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

const TARGET_URL = "https://www.google.com/";

function parseArgs(argv) {
    const out = {
        endpoint: process.env.VELORA_CDP || null,
        keep: false,
        query: null,
        output: resolve(repoRoot, "code-check/tmp/google"),
        timeout: 60_000,
        waitSeconds: 3,
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
            case "--query": out.query = next(); break;
            case "--output": out.output = resolve(next()); break;
            case "--timeout": out.timeout = Number(next()); break;
            case "--wait": out.waitSeconds = Number(next()); break;
            case "--help":
                console.log("Usage: node google-test.mjs [--endpoint <url>] [--keep] [--query <text>] [--output <dir>] [--timeout <ms>] [--wait <s>]");
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

async function waitForCdp(url, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(url);
            if (r.ok) return;
        } catch (_) {}
        await delay(100);
    }
    throw new Error(`CDP not ready: ${url}`);
}

async function spawnVelora() {
    if (!existsSync(veloraBin)) {
        throw new Error(`Velora binary not found at ${veloraBin}. Run \`zig build\` first.`);
    }
    const port = await getFreePort();
    const proc = spawn(
        veloraBin,
        ["serve", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warn", "--log-format", "pretty"],
        { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
    );
    const stderr = [];
    proc.stderr.on("data", (c) => stderr.push(c));
    proc.on("exit", (code, signal) => {
        if (code !== 0 && code !== null) {
            console.error(`[velora exited] code=${code} signal=${signal}`);
            console.error(Buffer.concat(stderr).toString());
        }
    });
    const endpoint = `http://127.0.0.1:${port}`;
    await waitForCdp(`${endpoint}/json/version`, 5000);
    return { proc, endpoint };
}

function fmtBytes(n) {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

async function fetchBody(session, requestId) {
    try {
        const body = await session.send("Network.getResponseBody", { requestId });
        return body?.base64Encoded
            ? Buffer.from(body.body || "", "base64").toString("utf8")
            : (body?.body || "");
    } catch (e) {
        return `(body fetch failed: ${e?.message ?? e})`;
    }
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    await mkdir(opts.output, { recursive: true });

    let veloraProc = null;
    let endpoint = opts.endpoint;
    if (!endpoint) {
        const spawned = await spawnVelora();
        veloraProc = spawned.proc;
        endpoint = spawned.endpoint;
        console.log(`[velora] spawned at ${endpoint}`);
    } else {
        console.log(`[velora] using existing endpoint ${endpoint}`);
    }

    const browser = await Browser.connect(endpoint);
    const consoleEntries = [];
    const errors = [];

    let exitCode = 0;
    try {
        const page = await browser.newPage();

        page.session.on("Runtime.consoleAPICalled", (event) => {
            const args = (event.args || []).map((a) => a.value ?? a.description ?? a.unserializableValue ?? `<${a.type}>`);
            consoleEntries.push({ type: event.type, args });
        });
        page.session.on("Runtime.exceptionThrown", (event) => {
            const ex = event.exceptionDetails;
            errors.push(ex?.exception?.description ?? ex?.text ?? "unknown exception");
        });

        console.log(`[goto] ${TARGET_URL}`);
        const t0 = Date.now();
        await page.goto(TARGET_URL, { waitUntil: "load", timeout: opts.timeout });
        console.log(`[goto] load fired in ${Date.now() - t0}ms`);

        if (opts.waitSeconds > 0) {
            console.log(`[wait] ${opts.waitSeconds}s for hydration`);
            await delay(opts.waitSeconds * 1000);
        }

        const probe = await page.evaluate(`(() => {
            const out = {
                title: document.title,
                url: location.href,
                cookieLength: document.cookie.length,
                bodyTextLen: (document.body?.innerText || "").length,
            };
            const form = document.querySelector('form[action="/search"], form[role="search"], form');
            const input = document.querySelector('input[name="q"], textarea[name="q"]');
            const btn = document.querySelector('input[name="btnK"], button[aria-label*="Search" i]');
            out.hasSearchForm = !!form;
            out.hasInputQ = !!input;
            out.hasSearchButton = !!btn;
            out.formAction = form?.getAttribute('action') || null;
            out.inputType = input?.tagName?.toLowerCase() || null;
            // Header / nav heuristics
            out.linkCount = document.querySelectorAll('a').length;
            out.scriptCount = document.querySelectorAll('script').length;
            out.previewText = (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 400);
            return out;
        })()`).catch((err) => ({ error: err?.message ?? String(err) }));

        console.log("\n=== Page probe ===");
        for (const [k, v] of Object.entries(probe)) {
            console.log(`  ${k}: ${typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : JSON.stringify(v)}`);
        }

        // Optional search query.
        let searchProbe = null;
        if (opts.query && probe.hasInputQ) {
            console.log(`\n[search] query="${opts.query}"`);
            try {
                // Submit via form.action (more reliable than emulating typing).
                await page.goto(`https://www.google.com/search?q=${encodeURIComponent(opts.query)}`, {
                    waitUntil: "load",
                    timeout: opts.timeout,
                });
                await delay(opts.waitSeconds * 1000);
                searchProbe = await page.evaluate(`(() => ({
                    title: document.title,
                    url: location.href,
                    resultCount: document.querySelectorAll('div#search, div.g, [data-ved]').length,
                    h3Sample: [...document.querySelectorAll('h3')].slice(0, 5).map(h => h.innerText),
                }))()`).catch((e) => ({ error: String(e) }));
                console.log("[search] result probe:", JSON.stringify(searchProbe, null, 2));
            } catch (e) {
                console.log(`[search] failed: ${e?.message ?? e}`);
            }
        }

        const html = await page.content().catch((err) => `<!-- content() failed: ${err?.message ?? err} -->`);
        const htmlPath = resolve(opts.output, "google.html");
        await writeFile(htmlPath, html);
        console.log(`[save] HTML -> ${htmlPath} (${fmtBytes(html.length)})`);

        // Network.
        const reqs = [...page.network.requests.values()];
        const finished = reqs.filter((r) => r.response);
        const failed = reqs.filter((r) => r.failureText);
        const non2xx = reqs.filter((r) => (r.response?.status ?? 0) >= 400);
        const byStatus = {};
        for (const r of finished) {
            const s = r.response?.status ?? 0;
            byStatus[s] = (byStatus[s] || 0) + 1;
        }

        console.log("\n=== Network ===");
        console.log(`  total:   ${reqs.length}`);
        console.log(`  resp:    ${finished.length}`);
        console.log(`  failed:  ${failed.length}`);
        console.log(`  status:  ${JSON.stringify(byStatus)}`);
        if (non2xx.length) {
            console.log(`  --- non-2xx (${non2xx.length}) ---`);
            for (const r of non2xx.slice(0, 10)) {
                console.log(`    [${r.response?.status}] ${r.method ?? "GET"} ${r.url}`);
            }
        }
        if (failed.length) {
            console.log(`  --- failed (${failed.length}) ---`);
            for (const r of failed.slice(0, 10)) {
                console.log(`    ${r.url} -> ${r.failureText}`);
            }
        }

        if (consoleEntries.length) {
            console.log(`\n=== Console (${consoleEntries.length}) ===`);
            for (const e of consoleEntries.slice(-15)) {
                console.log(`  [${e.type}] ${e.args.map(String).join(" ")}`);
            }
        }
        if (errors.length) {
            console.log(`\n=== JS exceptions (${errors.length}) ===`);
            for (const e of errors.slice(-10)) console.log(`  ${e}`);
            exitCode = 2;
        }

        // Verdict.
        const homepageOk = !!probe.hasInputQ && !!probe.hasSearchForm && errors.length === 0;
        let searchOk = true;
        let searchNote = "(skipped)";
        if (opts.query) {
            const blocked = !!searchProbe?.url?.includes("/sorry/")
                || non2xx.some((r) => /\/search\?/.test(r.url) && r.response?.status === 429);
            const hasResults = (searchProbe?.resultCount ?? 0) > 0 || (searchProbe?.h3Sample?.length ?? 0) > 0;
            searchOk = !blocked && hasResults;
            searchNote = blocked
                ? `BLOCKED (anti-bot: ${searchProbe?.url?.includes("/sorry/") ? "/sorry redirect" : "429"})`
                : (hasResults ? `OK (${searchProbe?.resultCount ?? 0} containers, ${(searchProbe?.h3Sample?.length ?? 0)} h3)` : "no results rendered");
        }
        const ok = homepageOk && searchOk;
        console.log(`\n=== Verdict ===`);
        console.log(`  homepage form/input:       ${probe.hasSearchForm}/${probe.hasInputQ}`);
        console.log(`  link/script count:         ${probe.linkCount}/${probe.scriptCount}`);
        console.log(`  search:                    ${searchNote}`);
        console.log(`  result:                    ${ok ? "PASS ✅" : "FAIL ❌"}`);
        if (!ok && exitCode === 0) exitCode = 1;

        const reportPath = resolve(opts.output, "report.json");
        await writeFile(reportPath, JSON.stringify({
            url: TARGET_URL,
            probe,
            search: searchProbe,
            requests: reqs.map((r) => ({
                url: r.url, method: r.method,
                status: r.response?.status, failure: r.failureText,
            })),
            console: consoleEntries,
            errors,
            durationMs: Date.now() - t0,
        }, null, 2));
        console.log(`[save] report -> ${reportPath}`);

        await page.close().catch(() => undefined);
    } catch (err) {
        console.error("FAILED:", err?.stack || err?.message || err);
        exitCode = 1;
    } finally {
        await browser.close().catch(() => undefined);
        if (veloraProc && !opts.keep) {
            veloraProc.kill("SIGTERM");
            await delay(200);
            if (!veloraProc.killed) veloraProc.kill("SIGKILL");
        }
    }
    process.exit(exitCode);
}

main();
