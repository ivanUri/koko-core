#!/usr/bin/env node
// Probe residential proxies: connectivity + Google direct search via Velora.
//
// Input format per line: label|ip:port:username:password
//
// Usage:
//   node code-check/sites/google/proxy-probe.mjs
//   node code-check/sites/google/proxy-probe.mjs --file proxies.txt

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");

const DEFAULT_PROXIES = `
61|103.145.253.139:20211:phcb5c7p:pHcB5c7P
61|202.55.134.47:34826:mamh6r8e:mAMH6r8e
61|202.55.135.142:64687:ixdg1b5l:iXDG1b5l
62|42.96.10.207:61639:futx1w7r:fUTX1w7R
62|180.214.239.232:56048:hhxi7s6p:hHXI7s6p
62|160.25.76.190:46214:uzth0q5c:uZtH0q5C
63|103.232.55.161:34424:txqs8d8i:tXqS8d8i
64|103.141.138.9:20211:enoj1s3a:eNOJ1s3a
65|103.167.92.182:59436:ncul4f4m:nCUL4f4m
65|103.187.5.227:64021:mxga6v9l:mXGA6v9l
65|103.190.81.10:49104:pgce5r2z:pGCE5r2Z
`.trim();

const SEARCH = "https://www.google.com/search?q=coingloo&hl=en";
const QUERY = "coingloo";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseProxyLine(line) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return null;
    const pipe = trimmed.indexOf("|");
    const label = pipe >= 0 ? trimmed.slice(0, pipe) : "?";
    const rest = pipe >= 0 ? trimmed.slice(pipe + 1) : trimmed;
    const parts = rest.split(":");
    if (parts.length < 4) throw new Error(`Bad proxy line: ${trimmed}`);
    const [host, port, user, pass] = parts;
    return {
        label,
        host,
        port: Number(port),
        user,
        pass,
        proxyUrl: `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`,
    };
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

function curlProbe(proxyUrl, timeoutSec = 20) {
    return new Promise((resolve) => {
        const args = [
            "-sS", "--max-time", String(timeoutSec),
            "-x", proxyUrl,
            "-w", "\n%{http_code}\n%{time_total}",
            "https://api.ipify.org?format=json",
        ];
        const proc = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        proc.stdout.on("data", (c) => { out += c; });
        proc.stderr.on("data", (c) => { err += c; });
        proc.on("close", (code) => {
            const lines = out.trim().split("\n");
            const httpCode = lines.at(-2) ?? "";
            const timeTotal = lines.at(-1) ?? "";
            const body = lines.slice(0, -2).join("\n").trim();
            let ip = null;
            try {
                ip = JSON.parse(body).ip ?? null;
            } catch {}
            resolve({
                ok: code === 0 && httpCode === "200" && ip,
                ip,
                httpCode,
                timeMs: Math.round(Number(timeTotal) * 1000) || null,
                err: code !== 0 ? (err.trim() || `exit ${code}`) : null,
            });
        });
    });
}

async function googleViaVelora(proxyUrl) {
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-sonoma",
        "--http-proxy", proxyUrl,
        "--http-connect-timeout", "25000",
        "--http-timeout", "60000",
        "--log-level", "warn",
    ], { cwd: repoRoot, stdio: "ignore" });

    const endpoint = `http://127.0.0.1:${port}`;
    try {
        for (let i = 0; i < 40; i++) {
            try {
                if ((await fetch(`${endpoint}/json/version`)).ok) break;
            } catch {}
            await delay(100);
        }

        const browser = await Browser.connect(endpoint);
        const page = await browser.newPage();
        const t0 = Date.now();
        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 75_000 });
        await delay(2000);
        const snap = await page.evaluate(() => {
            const html = document.documentElement?.innerHTML || "";
            return {
                url: location.href,
                sorry: location.href.includes("/sorry"),
                hits: document.querySelectorAll("#search .g h3, .MjjYud h3").length,
                title: document.title.slice(0, 80),
                serp: /SearchResultsPage/.test(html),
                sgs: /window\.sgs/.test(html),
                bytes: html.length,
            };
        });
        await browser.close();
        const pageKind = snap.serp ? "SERP" : snap.sgs ? "SGS" : snap.sorry ? "SORRY" : "other";
        return {
            ok: !snap.sorry && snap.serp,
            sorry: snap.sorry,
            serp: snap.serp,
            sgs: snap.sgs,
            page: pageKind,
            hits: snap.hits,
            bytes: snap.bytes,
            url: snap.url.slice(0, 120),
            title: snap.title,
            ms: Date.now() - t0,
        };
    } catch (e) {
        return { ok: false, error: String(e.message || e) };
    } finally {
        proc.kill("SIGTERM");
        await delay(200);
    }
}

function loadProxyLines() {
    const fileIdx = process.argv.indexOf("--file");
    if (fileIdx >= 0 && process.argv[fileIdx + 1]) {
        return readFileSync(resolve(process.argv[fileIdx + 1]), "utf8").split("\n");
    }
    return DEFAULT_PROXIES.split("\n");
}

async function main() {
    const limitIdx = process.argv.indexOf("--limit");
    const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : 0;
    let proxies = loadProxyLines().map(parseProxyLine).filter(Boolean);
    if (limit > 0) proxies = proxies.slice(0, limit);
    console.log(`Probing ${proxies.length} proxies (curl ipify + Velora Google direct)...\n`);

    const results = [];

    for (const p of proxies) {
        process.stdout.write(`[${p.label}] ${p.host}:${p.port} `);
        const curl = await curlProbe(p.proxyUrl);
        if (!curl.ok) {
            console.log(`curl FAIL — ${curl.err || curl.httpCode}`);
            results.push({ ...p, curl, google: null });
            continue;
        }
        process.stdout.write(`ip=${curl.ip} (${curl.timeMs}ms) → Google `);
        const google = await googleViaVelora(p.proxyUrl);
        if (google.error) {
            console.log(`ERR ${google.error}`);
        } else if (google.ok) {
            console.log(`SERP hits=${google.hits} ${google.bytes}B (${google.ms}ms)`);
        } else if (google.sorry) {
            console.log(`SORRY (${google.ms}ms)`);
        } else if (google.sgs) {
            console.log(`SGS ${google.bytes}B (${google.ms}ms)`);
        } else {
            console.log(`${google.page} hits=${google.hits} (${google.ms}ms)`);
        }
        results.push({ ...p, curl, google });
    }

    console.log("\n=== Summary ===");
    const alive = results.filter((r) => r.curl?.ok);
    const serp = results.filter((r) => r.google?.ok);
    const sgs = results.filter((r) => r.google?.sgs);
    const sorry = results.filter((r) => r.google?.sorry);
    console.log(`alive: ${alive.length}/${results.length}`);
    console.log(`SERP OK: ${serp.length}/${results.length}`);
    console.log(`SGS shell: ${sgs.length}/${results.length}`);
    console.log(`/sorry: ${sorry.length}/${results.length}`);
    if (serp.length) {
        console.log("\nWorking:");
        for (const r of serp) {
            console.log(`  ${r.host}:${r.port} exit=${r.curl.ip} hits=${r.google.hits}`);
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});