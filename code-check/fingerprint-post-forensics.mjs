#!/usr/bin/env node
// Capture POST headers, body size, response for Fingerprint playground
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const TARGET = "https://demo.fingerprint.com/playground";
const OUT = resolve(repoRoot, "code-check/tmp/fingerprint-post");

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
    const args = ["serve", "--host", "127.0.0.1", "--port", String(port), "--log-level", "warn"];
    if (profile) args.push("--browser-profile", profile);
    const proc = spawn(veloraBin, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    const endpoint = `http://127.0.0.1:${port}`;
    await waitForCdp(`${endpoint}/json/version`);
    return { proc, endpoint };
}

async function runCase(label, profile) {
    const { proc, endpoint } = await spawnVelora(profile);
    const posts = new Map();
    const finished = new Map();

    try {
        const browser = await Browser.connect(endpoint);
        const page = await browser.newPage();
        await page.session.send("Network.enable", { maxPostDataSize: 131072 }).catch(() => page.session.send("Network.enable"));

        page.session.on("Network.requestWillBeSent", (e) => {
            const req = e.request;
            if (req?.method !== "POST") return;
            if (!/fingerprint|fpjs|DBqbMN7z/i.test(req.url || "")) return;
            posts.set(e.requestId, {
                requestId: e.requestId,
                url: req.url,
                method: req.method,
                type: e.type,
                hasPostData: req.hasPostData ?? false,
                postDataLen: req.postData?.length ?? 0,
                postDataPreview: req.postData ? Buffer.from(req.postData.slice(0, 64), "utf8").toString("hex") : null,
                headers: req.headers ?? {},
            });
        });

        page.session.on("Network.loadingFinished", (e) => {
            finished.set(e.requestId, e.encodedDataLength ?? null);
        });

        await page.goto(TARGET, { waitUntil: "load", timeout: 90000 });
        await delay(15000);

        const nav = await page.evaluate(`(() => ({
            userAgent: navigator.userAgent,
            vendor: navigator.vendor,
            platform: navigator.platform,
            brands: navigator.userAgentData?.brands,
            uaFullVersion: navigator.userAgentData?.getHighEntropyValues ? "has-getHighEntropyValues" : null,
        }))()`).catch((e) => ({ error: String(e) }));

        const results = [];
        for (const [id, meta] of posts) {
            let postBody = null;
            let postBodyLen = meta.postDataLen;
            try {
                const pd = await page.session.send("Network.getRequestPostData", { requestId: id });
                postBody = pd?.postData ?? null;
                postBodyLen = postBody?.length ?? postBodyLen;
            } catch (e) {
                postBody = `getRequestPostData failed: ${e?.message ?? e}`;
            }

            let responseBody = null;
            let status = null;
            try {
                const resp = await page.session.send("Network.getResponseBody", { requestId: id });
                responseBody = resp?.base64Encoded
                    ? Buffer.from(resp.body || "", "base64").toString("utf8")
                    : (resp?.body || "");
            } catch (e) {
                responseBody = `getResponseBody failed: ${e?.message ?? e}`;
            }

            const reqEntry = [...page.network.requests.values()].find((r) => r.requestId === id);
            status = reqEntry?.response?.status ?? null;

            results.push({
                ...meta,
                encodedDataLength: finished.get(id) ?? null,
                postBodyLen,
                postBodyHexPreview: postBody && typeof postBody === "string" && !postBody.startsWith("getRequest")
                    ? Buffer.from(postBody.slice(0, 64)).toString("hex")
                    : null,
                status,
                responseBody: typeof responseBody === "string" ? responseBody.slice(0, 800) : responseBody,
            });
        }

        await page.close().catch(() => undefined);
        await browser.close().catch(() => undefined);
        return { label, profile: profile ?? "(default velora)", nav, results };
    } finally {
        proc.kill("SIGTERM");
        await delay(300);
        if (!proc.killed) proc.kill("SIGKILL");
    }
}

async function main() {
    await mkdir(OUT, { recursive: true });
    if (!existsSync(veloraBin)) throw new Error("Run zig build first");

    const cases = [
        await runCase("velora-default", null),
        await runCase("chrome-profile", "chrome-macos-catalina"),
    ];

    await writeFile(resolve(OUT, "post-forensics.json"), JSON.stringify(cases, null, 2));

    console.log("\n=== POST Forensics ===\n");
    for (const c of cases) {
        console.log(`--- ${c.label} (profile: ${c.profile}) ---`);
        console.log(`navigator.userAgent: ${c.nav.userAgent ?? c.nav.error}`);
        console.log(`navigator.vendor: ${c.nav.vendor}`);
        if (c.nav.brands) console.log(`brands: ${JSON.stringify(c.nav.brands)}`);
        for (const r of c.results) {
            console.log(`\nPOST ${r.url}`);
            console.log(`  status: ${r.status}`);
            console.log(`  hasPostData: ${r.hasPostData}, CDP postDataLen: ${r.postDataLen}, getRequestPostData len: ${r.postBodyLen}`);
            console.log(`  encodedDataLength: ${r.encodedDataLength}`);
            console.log(`  headers: ${JSON.stringify(r.headers, null, 2)}`);
            console.log(`  body hex preview: ${r.postBodyHexPreview ?? r.postDataPreview ?? "(none)"}`);
            console.log(`  response: ${r.responseBody}`);
        }
        console.log("");
    }
    console.log(`saved: ${OUT}/post-forensics.json`);
}

main().catch((err) => {
    console.error("FAILED:", err?.stack || err);
    process.exit(1);
});