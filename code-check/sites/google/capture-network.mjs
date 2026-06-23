#!/usr/bin/env node
// Capture document request headers during Google search flow.
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function getFreePort() {
    return new Promise((res, rej) => {
        const s = createNetServer();
        s.unref();
        s.on("error", rej);
        s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
    });
}

async function spawnVelora() {
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-catalina", "--log-level", "error",
    ], { cwd: repoRoot, stdio: "ignore" });
    const endpoint = `http://127.0.0.1:${port}`;
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch (_) {}
        await delay(100);
    }
    return { proc, endpoint };
}

function hdrMap(headers) {
    if (!headers) return {};
    if (Array.isArray(headers)) {
        const m = {};
        for (const h of headers) m[h.name.toLowerCase()] = h.value;
        return m;
    }
    const m = {};
    for (const [k, v] of Object.entries(headers)) m[k.toLowerCase()] = v;
    return m;
}

async function main() {
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    const { proc, endpoint } = await spawnVelora();
    const browser = await Browser.connect(endpoint);
    const docs = [];

    try {
        const page = await browser.newPage();
        const cdp = page.session;
        await cdp.send("Network.enable");

        cdp.on("Network.requestWillBeSent", (p) => {
            if (p.type === "Document" || p.type === "document") {
                docs.push({
                    url: p.request.url,
                    method: p.request.method,
                    headers: hdrMap(p.request.headers),
                    ts: p.timestamp,
                });
            }
        });

        await page.goto("https://www.google.com/ncr", { waitUntil: "load", timeout: 60000 });
        await delay(2000);

        // Test A: direct goto search
        console.log("\n=== Direct goto search ===");
        docs.length = 0;
        await page.goto("https://www.google.com/search?q=velora+browser&hl=en", {
            waitUntil: "domcontentloaded", timeout: 60000,
        });
        await delay(1500);
        const direct = await page.evaluate("({ url: location.href, title: document.title })");
        console.log("result:", direct.url.slice(0, 120));
        for (const d of docs) {
            console.log("\nDOC", d.method, d.url.slice(0, 100));
            for (const k of ["referer", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user", "accept", "cookie", "user-agent", "sec-ch-ua"]) {
                if (d.headers[k]) console.log(`  ${k}: ${String(d.headers[k]).slice(0, 200)}`);
            }
        }

        // Test B: back to home, type+enter
        await page.goto("https://www.google.com/ncr", { waitUntil: "load", timeout: 60000 });
        await delay(2500);
        console.log("\n=== Type+Enter search ===");
        docs.length = 0;
        const nav = page.waiter.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 });
        nav.catch(() => undefined);
        await page.type('textarea[name="q"], input[name="q"]', "velora browser");
        await delay(400);
        await page.press("Enter");
        await nav;
        await delay(1500);
        const typed = await page.evaluate("({ url: location.href })");
        console.log("result:", typed.url.slice(0, 120));
        for (const d of docs) {
            console.log("\nDOC", d.method, d.url.slice(0, 100));
            for (const k of ["referer", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user", "accept", "cookie", "user-agent", "sec-ch-ua"]) {
                if (d.headers[k]) console.log(`  ${k}: ${String(d.headers[k]).slice(0, 200)}`);
            }
        }
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

main().catch((e) => { console.error(e); process.exit(1); });