#!/usr/bin/env node
/**
 * Run practical fingerprint / bot-detection regression cases against Velora.
 *
 * Usage:
 *   node code-check/suite/runner.mjs
 *   node code-check/suite/runner.mjs --remote
 *   node code-check/suite/runner.mjs --case creepjs-local
 *   node code-check/suite/runner.mjs --compare-browser
 */

import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import { BROWSERLEAKS_CASES, LOCAL_CASES, REMOTE_CASES, SCRIPT_CASES } from "./cases.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const codeCheckRoot = resolve(__dirname, "..");
const repoRoot = resolve(codeCheckRoot, "..");
const localRoot = resolve(codeCheckRoot, "local");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const outputDir = resolve(codeCheckRoot, "tmp/fingerprint-suite");

const contentTypes = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
};

function usage() {
    return `Usage: node code-check/suite/runner.mjs [options]

Options:
  --remote              Include remote cases (BrowserLeaks, BrowserScan, Fingerprint playground)
  --browserleaks        Run BrowserLeaks remote cases only
  --scripts             Include script cases (dual-diagnostic; slow)
  --case <id>           Run a single case by id
  --prefix <id-prefix>  Run cases whose id starts with prefix (e.g. browserleaks-)
  --compare-browser     Also run local cases in Chromium (Playwright)
  --profile <name>      Velora browser profile (default: chrome-macos-catalina)
  --report <path>       JSON report path (default: code-check/tmp/fingerprint-suite/report.json)
  --html <path>         HTML report path (default: code-check/tmp/fingerprint-suite/report.html)
  --timeout <ms>        Default per-case timeout override
  --help                Show this help
`;
}

function parseArgs(argv) {
    const out = {
        remote: false,
        browserleaks: false,
        scripts: false,
        caseId: null,
        casePrefix: null,
        compareBrowser: false,
        profile: "chrome-macos-catalina",
        report: resolve(outputDir, "report.json"),
        html: resolve(outputDir, "report.html"),
        timeout: null,
        help: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => {
            if (i + 1 >= argv.length) throw new Error(`Missing value for ${a}`);
            i += 1;
            return argv[i];
        };
        switch (a) {
            case "--remote": out.remote = true; break;
            case "--browserleaks": out.browserleaks = true; break;
            case "--scripts": out.scripts = true; break;
            case "--case": out.caseId = next(); break;
            case "--prefix": out.casePrefix = next(); break;
            case "--compare-browser": out.compareBrowser = true; break;
            case "--profile": out.profile = next(); break;
            case "--report": out.report = resolve(next()); break;
            case "--html": out.html = resolve(next()); break;
            case "--timeout": out.timeout = Number(next()); break;
            case "--help":
            case "-h": out.help = true; break;
            default:
                if (a.startsWith("--")) throw new Error(`Unknown option: ${a}`);
        }
    }
    return out;
}

function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function getFreePort(host = "127.0.0.1") {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.unref();
        s.on("error", rej);
        s.listen(0, host, () => {
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
        } catch (_) {}
        await delay(100);
    }
    throw new Error(`CDP not ready: ${url}`);
}

async function spawnVelora(profile) {
    const port = await getFreePort();
    const args = [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--log-level", "warn", "--log-format", "pretty",
        "--browser-profile", profile,
    ];
    const proc = spawn(veloraBin, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    const endpoint = `http://127.0.0.1:${port}`;
    await waitForCdp(`${endpoint}/json/version`);
    return { proc, endpoint };
}

async function startStaticServer(host, port, rootDir) {
    const server = createHttpServer((req, res) => {
        const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
        const safe = urlPath.replace(/\.\./g, "");
        const filePath = resolve(rootDir, `.${safe}`);
        if (!filePath.startsWith(rootDir)) {
            res.writeHead(403);
            res.end("Forbidden");
            return;
        }
        if (!existsSync(filePath)) {
            res.writeHead(404);
            res.end("Not found");
            return;
        }
        res.writeHead(200, { "content-type": contentTypes[extname(filePath)] || "application/octet-stream" });
        createReadStream(filePath).pipe(res);
    });
    await new Promise((res, rej) => {
        server.on("error", rej);
        server.listen(port, host, res);
    });
    return server;
}

async function connectCDP(endpoint, commandTimeoutMs = 15_000) {
    const versionRes = await fetch(`${endpoint}/json/version`);
    if (!versionRes.ok) throw new Error(`CDP version HTTP ${versionRes.status}`);
    const { webSocketDebuggerUrl } = await versionRes.json();
    const ws = new WebSocket(webSocketDebuggerUrl);
    const callbacks = new Map();
    let nextId = 1;
    let closed = false;

    ws.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.id == null || !callbacks.has(message.id)) return;
        const cb = callbacks.get(message.id);
        callbacks.delete(message.id);
        if (cb.timer) clearTimeout(cb.timer);
        if (message.error) cb.reject(new Error(`${cb.method}: ${message.error.message}`));
        else cb.resolve(message.result || {});
    });

    await new Promise((res, rej) => {
        ws.once("open", res);
        ws.once("error", rej);
    });

    return {
        send(method, params = {}, sessionId) {
            if (closed) return Promise.reject(new Error("CDP closed"));
            const id = nextId++;
            const payload = { id, method, params };
            if (sessionId) payload.sessionId = sessionId;
            return new Promise((res, rej) => {
                const timer = setTimeout(() => {
                    callbacks.delete(id);
                    rej(new Error(`${method} timed out`));
                }, commandTimeoutMs);
                callbacks.set(id, { method, resolve: res, reject: rej, timer });
                ws.send(JSON.stringify(payload));
            });
        },
        close() {
            closed = true;
            ws.close();
        },
    };
}

async function createPage(cdp) {
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    return { targetId, sessionId };
}

async function evaluate(cdp, sessionId, expression) {
    const result = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
    }, sessionId);
    if (result.exceptionDetails) {
        throw new Error(JSON.stringify(result.exceptionDetails));
    }
    return result.result?.value;
}

async function runPageCase(cdp, sessionId, url, testCase) {
    const timeoutMs = testCase.timeoutMs;
    await cdp.send("Page.navigate", { url }, sessionId);
    await delay(testCase.waitMs || 1000);

    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
        try {
            last = await evaluate(cdp, sessionId, testCase.collect);
            if (last?.pass === true) break;
            if (last?.pass === false && !testCase.pollMs) break;
        } catch (err) {
            last = { pass: false, summary: String(err.message || err), error: String(err) };
        }
        if (!testCase.pollMs) break;
        await delay(testCase.pollMs);
    }
    return last || { pass: false, summary: "no result" };
}

async function runLocalCase(caseDef, endpoint, compareBrowser) {
    const host = "127.0.0.1";
    const port = await getFreePort(host);
    const server = await startStaticServer(host, port, localRoot);
    const url = `http://${host}:${port}${caseDef.path}`;

    const cdp = await connectCDP(endpoint);
    const { sessionId } = await createPage(cdp);
    let veloraResult;
    try {
        veloraResult = await runPageCase(cdp, sessionId, url, caseDef);
    } finally {
        cdp.close();
    }
    server.close();

    let chromeResult = null;
    if (compareBrowser) {
        chromeResult = await runChromiumPageCase(url, caseDef);
    }

    return {
        id: caseDef.id,
        name: caseDef.name,
        kind: caseDef.kind,
        url,
        velora: veloraResult,
        chrome: chromeResult,
        pass: veloraResult?.pass === true,
    };
}

async function runRemoteCase(caseDef, endpoint) {
    const cdp = await connectCDP(endpoint);
    const { sessionId } = await createPage(cdp);
    let veloraResult;
    try {
        veloraResult = await runPageCase(cdp, sessionId, caseDef.url, caseDef);
    } finally {
        cdp.close();
    }
    return {
        id: caseDef.id,
        name: caseDef.name,
        kind: caseDef.kind,
        url: caseDef.url,
        velora: veloraResult,
        pass: veloraResult?.pass === true,
    };
}

async function runChromiumPageCase(url, testCase) {
    let chromium;
    try {
        ({ chromium } = await import("playwright"));
    } catch (err) {
        return { pass: false, summary: `playwright missing: ${err.message}` };
    }
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "load", timeout: testCase.timeoutMs });
        await page.waitForTimeout(testCase.waitMs || 1000);
        const started = Date.now();
        let last = null;
        while (Date.now() - started < testCase.timeoutMs) {
            last = await page.evaluate(testCase.collect);
            if (last?.pass === true) break;
            if (!testCase.pollMs) break;
            await page.waitForTimeout(testCase.pollMs);
        }
        return last || { pass: false, summary: "no result" };
    } finally {
        await browser.close();
    }
}

function runScriptCase(caseDef) {
    return new Promise((res) => {
        const scriptPath = resolve(codeCheckRoot, caseDef.script);
        const proc = spawn(process.execPath, [scriptPath], {
            cwd: repoRoot,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, FORCE_COLOR: "0" },
        });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (c) => { stdout += c; });
        proc.stderr.on("data", (c) => { stderr += c; });
        const timer = setTimeout(() => {
            proc.kill("SIGTERM");
        }, caseDef.timeoutMs);
        proc.on("close", (code) => {
            clearTimeout(timer);
            const pass = code === 0;
            res({
                id: caseDef.id,
                name: caseDef.name,
                kind: caseDef.kind,
                velora: {
                    pass,
                    summary: pass ? "script exited 0" : `exit ${code}`,
                    exitCode: code,
                    stdout: stdout.slice(-2000),
                    stderr: stderr.slice(-2000),
                },
                pass,
            });
        });
    });
}

function buildHtmlReport(report) {
    const rows = report.results.map((r) => {
        const status = r.pass ? "PASS" : "FAIL";
        const velora = r.velora || {};
        const chrome = r.chrome ? `<div class="chrome"><b>Chrome:</b> ${escapeHtml(JSON.stringify(r.chrome))}</div>` : "";
        return `<tr class="${status.toLowerCase()}">
<td><code>${escapeHtml(r.id)}</code></td>
<td>${escapeHtml(r.name)}</td>
<td><span class="pill ${status.toLowerCase()}">${status}</span></td>
<td>${escapeHtml(velora.summary || "-")}</td>
<td>${escapeHtml(r.url || r.kind || "")}</td>
</tr>
<tr class="detail"><td colspan="5">${chrome}<pre>${escapeHtml(JSON.stringify(velora.metrics || velora, null, 2))}</pre></td></tr>`;
    }).join("\n");

    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Velora Fingerprint Suite</title>
<style>
body{font-family:system-ui,sans-serif;margin:24px;background:#0f1115;color:#e8eaed}
h1{font-size:1.4rem}
.meta{color:#9aa0a6;margin-bottom:20px}
table{width:100%;border-collapse:collapse}
th,td{border-bottom:1px solid #2a2f3a;padding:10px;text-align:left;vertical-align:top}
.pill{padding:2px 8px;border-radius:6px;font-size:12px;font-weight:600}
.pill.pass{background:#1e3a2f;color:#4cca9f}
.pill.fail{background:#3a1e1e;color:#f28b82}
tr.detail pre{font-size:11px;white-space:pre-wrap;color:#9aa0a6;margin:0}
.chrome{margin-bottom:8px;font-size:12px}
</style></head><body>
<h1>Velora Fingerprint Suite</h1>
<div class="meta">Profile: ${escapeHtml(report.profile)} · ${report.passed}/${report.total} passed · ${escapeHtml(report.finishedAt)}</div>
<table><thead><tr><th>ID</th><th>Case</th><th>Status</th><th>Summary</th><th>URL/Kind</th></tr></thead>
<tbody>${rows}</tbody></table></body></html>`;
}

function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>'"]/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
    }[c]));
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(usage());
        return;
    }
    if (!existsSync(veloraBin)) {
        throw new Error(`velora binary not found: ${veloraBin} (run zig build first)`);
    }

    let cases = [...LOCAL_CASES];
    if (opts.browserleaks) {
        cases = BROWSERLEAKS_CASES;
    } else {
        if (opts.remote) cases = cases.concat(REMOTE_CASES);
        if (opts.scripts) cases = cases.concat(SCRIPT_CASES);
    }
    if (opts.caseId) {
        cases = cases.filter((c) => c.id === opts.caseId);
        if (cases.length === 0) throw new Error(`Unknown case: ${opts.caseId}`);
    }
    if (opts.casePrefix) {
        cases = cases.filter((c) => c.id.startsWith(opts.casePrefix));
        if (cases.length === 0) throw new Error(`No cases match prefix: ${opts.casePrefix}`);
    }
    if (opts.timeout) {
        cases = cases.map((c) => ({ ...c, timeoutMs: opts.timeout }));
    }

    mkdirSync(dirname(opts.report), { recursive: true });

    const { proc, endpoint } = await spawnVelora(opts.profile);
    const results = [];

    try {
        for (const caseDef of cases) {
            process.stdout.write(`${caseDef.id} ... `);
            try {
                let result;
                if (caseDef.kind === "script") {
                    result = await runScriptCase(caseDef);
                } else if (caseDef.kind === "remote") {
                    result = await runRemoteCase(caseDef, endpoint);
                } else {
                    result = await runLocalCase(caseDef, endpoint, opts.compareBrowser);
                }
                results.push(result);
                console.log(result.pass ? "PASS" : "FAIL", result.velora?.summary || "");
            } catch (err) {
                results.push({
                    id: caseDef.id,
                    name: caseDef.name,
                    kind: caseDef.kind,
                    pass: false,
                    velora: { pass: false, summary: String(err.message || err) },
                });
                console.log("FAIL", err.message || err);
            }
        }
    } finally {
        proc.kill("SIGTERM");
    }

    const passed = results.filter((r) => r.pass).length;
    const report = {
        profile: opts.profile,
        finishedAt: new Date().toISOString(),
        total: results.length,
        passed,
        failed: results.length - passed,
        results,
    };

    writeFileSync(opts.report, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(opts.html, buildHtmlReport(report));

    console.log(`\nReport: ${opts.report}`);
    console.log(`HTML:   ${opts.html}`);
    console.log(`Result: ${passed}/${results.length} passed`);

    if (passed < results.length) process.exit(1);
}

main().catch((err) => {
    console.error("FAILED:", err?.stack || err);
    process.exit(1);
});