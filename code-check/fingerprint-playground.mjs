#!/usr/bin/env node
// Truy cập https://demo.fingerprint.com/playground qua Velora CDP + SDK,
// in ra HTML rút gọn, visitorId/requestId nếu Fingerprint khởi tạo được,
// thống kê network và lifecycle (frames, console errors).
//
// Cách chạy:
//   node code-check/fingerprint-playground.mjs
//
// Tuỳ chọn:
//   --endpoint <ws|http>   nếu đã có velora đang chạy, bỏ qua spawn
//   --keep                 không tự kill velora khi xong (debug)
//   --headful              forward thêm flag (hiện tại Velora không headless toggle, ignore)
//   --output <dir>         thư mục ghi html/screenshot (default code-check/tmp/fingerprint)
//   --timeout <ms>         navigation timeout (default 60000)
//   --wait <s>             sau load đợi thêm n giây để Fingerprint chạy xong (default 8)

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

const TARGET_URL = "https://wpt.fyi/results/dom/lists?label=experimental&label=master&aligned";

function parseArgs(argv) {
    const out = {
        endpoint: process.env.VELORA_CDP || null,
        keep: false,
        output: resolve(repoRoot, "code-check/tmp/fingerprint"),
        timeout: 60_000,
        waitSeconds: 8,
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
            case "--help":
                console.log("Usage: node fingerprint-playground.mjs [--endpoint <url>] [--keep] [--output <dir>] [--timeout <ms>] [--wait <s>]");
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

async function waitForCdp(url, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(url);
            if (r.ok) return;
        } catch (_) { /* not yet */ }
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
    let visitorId = null;
    let requestId = null;

    try {
        const page = await browser.newPage();

        // Hook console + page errors at CDP level so we still see them when JS throws.
        page.session.on("Runtime.consoleAPICalled", (event) => {
            const args = (event.args || []).map((a) => a.value ?? a.description ?? a.unserializableValue ?? `<${a.type}>`);
            consoleEntries.push({ type: event.type, args });
        });
        page.session.on("Runtime.exceptionThrown", (event) => {
            const ex = event.exceptionDetails;
            errors.push(ex?.exception?.description ?? ex?.text ?? "unknown exception");
        });

        // Spoof a realistic Chrome UA so Fingerprint's edge doesn't reject us.
        const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
        await page.session.send("Network.setUserAgentOverride", {
            userAgent: CHROME_UA,
            acceptLanguage: "en-US,en;q=0.9",
            platform: "MacIntel",
        }).catch((e) => console.warn(`[ua-override failed] ${e?.message ?? e}`));

        console.log(`[goto] ${TARGET_URL}`);
        const t0 = Date.now();
        await page.goto(TARGET_URL, { waitUntil: "load", timeout: opts.timeout });
        console.log(`[goto] load fired in ${Date.now() - t0}ms`);

        // Cho Fingerprint script chạy xong (load identification, gọi getVisitorData).
        if (opts.waitSeconds > 0) {
            console.log(`[wait] ${opts.waitSeconds}s for Fingerprint runtime`);
            await delay(opts.waitSeconds * 1000);
        }

        // Cố gắng đọc visitorId/requestId từ window. Demo của Fingerprint set lên window
        // khi chạy SDK; nếu không có thì dump phần text DOM hiển thị.
        const probe = await page.evaluate(`(() => {
            const out = { title: document.title, url: location.href };
            try {
                out.visitorId = window?.fp?.lastResult?.visitorId
                    || window?.__FP_VISITOR_ID__
                    || document.querySelector('[data-testid="visitor-id"]')?.textContent?.trim()
                    || null;
                out.requestId = window?.fp?.lastResult?.requestId
                    || window?.__FP_REQUEST_ID__
                    || document.querySelector('[data-testid="request-id"]')?.textContent?.trim()
                    || null;
                // Một số demo cũ đặt window.FingerprintJS hoặc result trong React state — fallback
                // ra toàn bộ text trong khu vực hiển thị kết quả.
                const resultArea = document.querySelector('[data-testid="result-section"], main, body');
                out.previewText = (resultArea?.innerText || '').slice(0, 800);
            } catch (e) {
                out.error = String(e);
            }
            return out;
        })()`).catch((err) => ({ error: err?.message ?? String(err) }));

        visitorId = probe.visitorId ?? null;
        requestId = probe.requestId ?? null;

        console.log("\n=== Page probe ===");
        console.log(`title:     ${probe.title ?? "?"}`);
        console.log(`url:       ${probe.url ?? "?"}`);
        console.log(`visitorId: ${visitorId ?? "(not detected)"}`);
        console.log(`requestId: ${requestId ?? "(not detected)"}`);
        if (probe.previewText) {
            console.log("--- previewText (first 800 chars) ---");
            console.log(probe.previewText);
            console.log("--- /previewText ---");
        }

        // Lưu HTML đầy đủ.
        const html = await page.content().catch((err) => `<!-- content() failed: ${err?.message ?? err} -->`);
        const htmlPath = resolve(opts.output, "playground.html");
        await writeFile(htmlPath, html);
        console.log(`[save] HTML -> ${htmlPath} (${fmtBytes(html.length)})`);

        // UA / locale / webdriver flags để phán đoán anti-bot.
        const env = await page.evaluate(`(() => ({
            userAgent: navigator.userAgent,
            languages: navigator.languages,
            platform: navigator.platform,
            webdriver: navigator.webdriver,
            vendor: navigator.vendor,
            hardwareConcurrency: navigator.hardwareConcurrency,
            chrome: typeof window.chrome,
            permissions: typeof navigator.permissions,
        }))()`).catch((e) => ({ error: String(e) }));
        console.log("\n=== Browser env ===");
        for (const [k, v] of Object.entries(env)) console.log(`  ${k}: ${JSON.stringify(v)}`);

        // Network summary.
        const reqs = [...page.network.requests.values()];

        // Lấy response body cho các request fingerprint bị non-2xx.
        const bad = reqs.filter((r) => {
            const s = r.response?.status ?? 0;
            return s >= 400;
        });
        if (bad.length) {
            console.log(`\n=== Non-2xx response bodies (${bad.length}) ===`);
            for (const r of bad) {
                try {
                    const body = await page.session.send("Network.getResponseBody", { requestId: r.requestId });
                    const text = body?.base64Encoded ? Buffer.from(body.body || "", "base64").toString("utf8") : (body?.body || "");
                    console.log(`[${r.response?.status}] ${r.method} ${r.url}`);
                    console.log(`  body (${text.length}B): ${text.slice(0, 600)}`);
                } catch (e) {
                    console.log(`[${r.response?.status}] ${r.url}  (body fetch failed: ${e?.message ?? e})`);
                }
            }
        }

        const finished = reqs.filter((r) => r.response);
        const failed = reqs.filter((r) => r.failureText);
        const fpRequests = reqs.filter((r) => /fpjs|fingerprint/i.test(r.url || ""));
        console.log("\n=== Network ===");
        console.log(`total requests: ${reqs.length}`);
        console.log(`with response:  ${finished.length}`);
        console.log(`failed:         ${failed.length}`);
        console.log(`fingerprint-*:  ${fpRequests.length}`);
        for (const r of fpRequests.slice(0, 20)) {
            const status = r.response?.status ?? (r.failureText ? `ERR:${r.failureText}` : "pending");
            console.log(`  [${status}] ${r.method ?? "GET"} ${r.url}`);
        }
        if (failed.length) {
            console.log("--- failures ---");
            for (const r of failed.slice(0, 10)) {
                console.log(`  ${r.url} -> ${r.failureText}`);
            }
        }

        // Console + JS exceptions captured.
        if (consoleEntries.length) {
            console.log(`\n=== Console (${consoleEntries.length}) ===`);
            for (const e of consoleEntries.slice(-15)) {
                console.log(`  [${e.type}] ${e.args.map(String).join(" ")}`);
            }
        }
        if (errors.length) {
            console.log(`\n=== JS exceptions (${errors.length}) ===`);
            for (const e of errors.slice(-10)) console.log(`  ${e}`);
        }

        const reportPath = resolve(opts.output, "report.json");
        await writeFile(reportPath, JSON.stringify({
            url: TARGET_URL,
            probe,
            visitorId,
            requestId,
            requests: reqs.map((r) => ({
                url: r.url,
                method: r.method,
                status: r.response?.status,
                failure: r.failureText,
            })),
            console: consoleEntries,
            errors,
            durationMs: Date.now() - t0,
        }, null, 2));
        console.log(`[save] report -> ${reportPath}`);

        await page.close().catch(() => undefined);
    } finally {
        await browser.close().catch(() => undefined);
        if (veloraProc && !opts.keep) {
            veloraProc.kill("SIGTERM");
            await delay(200);
            if (!veloraProc.killed) veloraProc.kill("SIGKILL");
        }
    }
}

main().catch((err) => {
    console.error("FAILED:", err?.stack || err?.message || err);
    process.exit(1);
});
