#!/usr/bin/env node
// Guest Chrome omnibox mimic: cold Page.navigate → google.com/search?q=...
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const OUT = resolve(repoRoot, "code-check/tmp/google-omnibox");
const CLI_ARGS = process.argv.slice(2);
const useChromeTransport = CLI_ARGS.includes("--chrome-transport");
const QUERY = CLI_ARGS.find((a) => !a.startsWith("--")) || "coingloo.com";
const SEARCH = `https://www.google.com/search?q=${encodeURIComponent(QUERY)}`;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function classify(html) {
    const h = String(html || "");
    return {
        bytes: Buffer.byteLength(h, "utf8"),
        page: /SearchResultsPage/.test(h) ? "SERP" : /window\.sgs/.test(h) ? "SGS" : "other",
        title: (h.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.slice(0, 80) ?? null,
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

async function main() {
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    mkdirSync(OUT, { recursive: true });

    const port = await getFreePort();
    const serveArgs = [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-sonoma", "--log-level", "warn",
    ];
    if (useChromeTransport) serveArgs.push("--google-chrome-transport");
    const proc = spawn(veloraBin, serveArgs, {
        cwd: repoRoot,
        stdio: "ignore",
        env: { ...process.env, VELORA_ROOT: repoRoot },
    });

    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i++) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {}
        await delay(100);
    }

    const docs = [];
    const browser = await Browser.connect(endpoint);
    try {
        const page = await browser.newPage();
        const cdp = page.session;
        await cdp.send("Network.enable");

        cdp.on("Network.requestWillBeSent", (p) => {
            if (p.type !== "Document" || !p.request?.url?.includes("google.com/search")) return;
            const h = p.request.headers || {};
            const cookie = h.Cookie || h.cookie || "";
            docs.push({
                url: p.request.url.slice(0, 120),
                cookieLen: cookie.length,
                secFetchSite: h["sec-fetch-site"] || h["Sec-Fetch-Site"],
                referer: h.Referer || h.referer || null,
                hasSecFetchUser: !!(h["sec-fetch-user"] || h["Sec-Fetch-User"]),
            });
        });

        cdp.on("Network.responseReceived", async (p) => {
            if (p.type !== "Document" || !p.request?.url?.includes("google.com/search")) return;
            if (p.request.url.includes("sg_ss=")) return;
            for (let i = 0; i < 25; i++) {
                try {
                    const body = await cdp.send("Network.getResponseBody", { requestId: p.requestId });
                    const html = body.base64Encoded
                        ? Buffer.from(body.body, "base64").toString("utf8")
                        : body.body;
                    docs[docs.length - 1] = {
                        ...docs[docs.length - 1],
                        status: p.response?.status,
                        protocol: p.response?.protocol,
                        bodyClass: classify(html),
                    };
                    if (!p.request.url.includes("sei=")) {
                        writeFileSync(resolve(OUT, "hop1.html"), html.slice(0, 2_000_000));
                    }
                    break;
                } catch {
                    await delay(50);
                }
            }
        });

        console.log(`[omnibox] goto ${SEARCH}`);
        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await delay(3000);

        const finalUrl = await page.evaluate(() => location.href);
        const report = { query: QUERY, search: SEARCH, docs, finalUrl: finalUrl.slice(0, 200) };
        writeFileSync(resolve(OUT, "report.json"), JSON.stringify(report, null, 2));

        console.log("\n=== Document hops ===");
        for (const d of docs) {
            console.log(
                `${d.protocol ?? "?"} ${d.status ?? "?"} ${d.bodyClass?.page ?? "?"} ${d.bodyClass?.bytes ?? 0}B`,
            );
            console.log(`  site=${d.secFetchSite} cookies=${d.cookieLen} ref=${(d.referer || "").slice(0, 60)}`);
        }
        console.log(`\nfinal: ${report.finalUrl}`);
        console.log(`saved: ${OUT}/report.json`);
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});