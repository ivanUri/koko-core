#!/usr/bin/env node
// Deep diagnostic for https://demo.fingerprint.com/playground
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
const TARGET = "https://demo.fingerprint.com/playground";
const OUT = resolve(repoRoot, "code-check/tmp/fingerprint-deep");

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

async function waitForCdp(url, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(url);
            if (r.ok) return;
        } catch (_) { }
        await delay(100);
    }
    throw new Error(`CDP not ready: ${url}`);
}

async function spawnVelora(profile) {
    const port = await getFreePort();
    const args = ["serve", "--host", "127.0.0.1", "--port", String(port), "--log-level", "info", "--log-format", "pretty"];
    if (profile) args.push("--browser-profile", profile);
    const stderr = [];
    const proc = spawn(veloraBin, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", (c) => stderr.push(c));
    const endpoint = `http://127.0.0.1:${port}`;
    await waitForCdp(`${endpoint}/json/version`);
    return { proc, endpoint, stderr };
}

const probeScript = `(() => {
    const out = {
        ts: Date.now(),
        title: document.title,
        bodyText: (document.body?.innerText || "").slice(0, 1200),
        globals: {
            FingerprintJS: typeof globalThis.FingerprintJS,
            fp: typeof globalThis.fp,
            __fpjs: typeof globalThis.__fpjs,
            __FP_VISITOR_ID__: globalThis.__FP_VISITOR_ID__ ?? null,
            __FP_REQUEST_ID__: globalThis.__FP_REQUEST_ID__ ?? null,
        },
        nav: {
            userAgent: navigator.userAgent,
            webdriver: navigator.webdriver,
            vendor: navigator.vendor,
            platform: navigator.platform,
            languages: navigator.languages,
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: navigator.deviceMemory,
            maxTouchPoints: navigator.maxTouchPoints,
            cookieEnabled: navigator.cookieEnabled,
        },
        apis: {
            fetch: typeof fetch,
            XMLHttpRequest: typeof XMLHttpRequest,
            Worker: typeof Worker,
            SharedWorker: typeof SharedWorker,
            ServiceWorker: "serviceWorker" in navigator,
            WebSocket: typeof WebSocket,
            RTCPeerConnection: typeof RTCPeerConnection,
            crypto: typeof crypto,
            subtle: typeof crypto?.subtle,
            performance: typeof performance,
            requestIdleCallback: typeof requestIdleCallback,
            Intl: typeof Intl,
            canvas: !!document.createElement("canvas").getContext("2d"),
            webgl: !!document.createElement("canvas").getContext("webgl"),
            audio: typeof AudioContext !== "undefined" || typeof webkitAudioContext !== "undefined",
            permissions: typeof navigator.permissions,
            storage: typeof navigator.storage,
            indexedDB: typeof indexedDB,
            localStorage: (() => { try { return typeof localStorage; } catch (e) { return "blocked:" + e; } })(),
        },
        errors: [],
    };
    try {
        const ids = ["visitor-id", "request-id", "result-section"];
        out.dom = Object.fromEntries(ids.map((id) => {
            const el = document.querySelector('[data-testid="' + id + '"]');
            return [id, el ? (el.textContent || "").trim().slice(0, 200) : null];
        }));
    } catch (e) { out.errors.push("dom:" + e); }
    try {
        if (globalThis.fp?.lastResult) {
            out.fpLastResult = {
                visitorId: globalThis.fp.lastResult.visitorId ?? null,
                requestId: globalThis.fp.lastResult.requestId ?? null,
                keys: Object.keys(globalThis.fp.lastResult).slice(0, 20),
            };
        }
    } catch (e) { out.errors.push("fp:" + e); }
    return out;
})()`;

async function main() {
    await mkdir(OUT, { recursive: true });
    if (!existsSync(veloraBin)) throw new Error("Run zig build first");

    const { proc, endpoint, stderr } = await spawnVelora("chrome-macos-catalina");
    const events = { requests: [], responses: [], failed: [], console: [], exceptions: [] };
    const timeline = [];

    try {
        const browser = await Browser.connect(endpoint);
        const page = await browser.newPage();
        await page.session.send("Network.enable", { maxPostDataSize: 65536 }).catch(() => page.session.send("Network.enable"));
        await page.session.send("Log.enable").catch(() => undefined);

        page.session.on("Network.requestWillBeSent", (e) => {
            events.requests.push({
                t: Date.now(),
                id: e.requestId,
                method: e.request?.method,
                url: e.request?.url,
                type: e.type,
                postData: e.request?.postData ? e.request.postData.slice(0, 500) : null,
                hasPostData: e.request?.hasPostData ?? false,
            });
        });
        page.session.on("Network.responseReceived", (e) => {
            events.responses.push({
                t: Date.now(),
                id: e.requestId,
                url: e.response?.url,
                status: e.response?.status,
                mime: e.response?.mimeType,
            });
        });
        page.session.on("Network.loadingFailed", (e) => {
            events.failed.push({ t: Date.now(), id: e.requestId, error: e.errorText, canceled: e.canceled });
        });
        page.session.on("Runtime.consoleAPICalled", (e) => {
            const args = (e.args || []).map((a) => a.value ?? a.description ?? a.type);
            events.console.push({ t: Date.now(), type: e.type, args });
        });
        page.session.on("Runtime.exceptionThrown", (e) => {
            const ex = e.exceptionDetails;
            events.exceptions.push({
                t: Date.now(),
                text: ex?.text,
                desc: ex?.exception?.description,
                url: ex?.url,
                line: ex?.lineNumber,
            });
        });
        page.session.on("Log.entryAdded", (e) => {
            events.console.push({ t: Date.now(), type: "log." + (e.entry?.source || "?"), args: [e.entry?.text] });
        });

        const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
        await page.session.send("Network.setUserAgentOverride", {
            userAgent: CHROME_UA,
            acceptLanguage: "en-US,en;q=0.9",
            platform: "MacIntel",
        }).catch(() => undefined);

        const t0 = Date.now();
        console.log(`[goto] ${TARGET}`);
        await page.goto(TARGET, { waitUntil: "load", timeout: 90000 });
        console.log(`[goto] load in ${Date.now() - t0}ms`);

        for (let i = 0; i < 12; i += 1) {
            await delay(5000);
            const snap = await page.evaluate(probeScript).catch((e) => ({ error: String(e) }));
            timeline.push({ elapsedMs: Date.now() - t0, snap });
            const preview = snap.bodyText?.split("\n").find((l) => /visitor|timeout|error|intelligence/i.test(l)) || snap.bodyText?.slice(0, 80);
            console.log(`[poll ${(i + 1) * 5}s] ${preview}`);
            if (snap.bodyText?.includes("Visitor ID") || snap.fpLastResult?.visitorId) break;
        }

        const fpReqs = events.requests.filter((r) => /fingerprint|fpjs|\/web\/v|\/tdSBLg|DBqbMN7z/i.test(r.url || ""));
        const posts = events.requests.filter((r) => r.method === "POST");
        const summary = {
            url: TARGET,
            profile: "chrome-macos-catalina",
            durationMs: Date.now() - t0,
            requestCount: events.requests.length,
            responseCount: events.responses.length,
            failedCount: events.failed.length,
            postCount: posts.length,
            fingerprintRequestCount: fpReqs.length,
            posts: posts.map((r) => ({ url: r.url, hasPostData: r.hasPostData, postPreview: r.postData?.slice(0, 200) })),
            fingerprintRequests: fpReqs.map((r) => ({
                method: r.method,
                url: r.url,
                type: r.type,
                hasPostData: r.hasPostData,
            })),
            fingerprintResponses: events.responses
                .filter((r) => /fingerprint|fpjs|\/web\/v|\/tdSBLg|DBqbMN7z/i.test(r.url || ""))
                .map((r) => ({ status: r.status, url: r.url, mime: r.mime })),
            failures: events.failed,
            consoleTail: events.console.slice(-30),
            exceptions: events.exceptions,
            timeline,
            finalSnap: timeline.at(-1)?.snap ?? null,
        };

        await writeFile(resolve(OUT, "deep-report.json"), JSON.stringify({ summary, events }, null, 2));
        const html = await page.content();
        await writeFile(resolve(OUT, "playground.html"), html);
        await writeFile(resolve(OUT, "velora.log"), Buffer.concat(stderr).toString());

        console.log("\n=== Deep summary ===");
        console.log(`requests: ${summary.requestCount}, POST: ${summary.postCount}, failed: ${summary.failedCount}`);
        console.log(`fingerprint-related requests: ${summary.fingerprintRequestCount}`);
        for (const r of summary.fingerprintRequests) {
            console.log(`  [${r.method}] ${r.type || "-"} ${r.url}${r.hasPostData ? " (hasPostData)" : ""}`);
        }
        if (summary.posts.length) {
            console.log("POST bodies preview:");
            for (const p of summary.posts) console.log(`  ${p.url}\n    ${p.postPreview || "(empty)"}`);
        }
        if (summary.failures.length) {
            console.log("Network failures:");
            for (const f of summary.failures) console.log(`  ${f.id}: ${f.error}`);
        }
        if (summary.exceptions.length) {
            console.log("JS exceptions:");
            for (const ex of summary.exceptions) console.log(`  ${ex.desc || ex.text}`);
        }
        if (summary.consoleTail.length) {
            console.log("Console tail:");
            for (const c of summary.consoleTail.slice(-10)) console.log(`  [${c.type}] ${c.args?.join(" ")}`);
        }
        console.log(`\nfinal body snippet: ${summary.finalSnap?.bodyText?.slice(0, 200)}`);
        console.log(`\nsaved: ${OUT}/deep-report.json`);

        await page.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
    } finally {
        proc.kill("SIGTERM");
        await delay(300);
        if (!proc.killed) proc.kill("SIGKILL");
    }
}

main().catch((err) => {
    console.error("FAILED:", err?.stack || err);
    process.exit(1);
});