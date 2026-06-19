#!/usr/bin/env node
// Lấy dữ liệu profile TikTok (@username) qua Velora.
// TikTok nhúng SSR trong #__UNIVERSAL_DATA_FOR_REHYDRATION__ — cần đọc sớm sau load
// vì React có thể chuyển sang downgrade/spinner và xoá DOM.
//
// Usage:
//   node code-check/sites/tiktok/profile.mjs
//   node code-check/sites/tiktok/profile.mjs --handle fashion83868888
//   node code-check/sites/tiktok/profile.mjs --url "https://www.tiktok.com/@fashion83868888?lang=en"

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
const BROWSER_PROFILE = "chrome-macos-catalina";

function parseArgs(argv) {
    const out = {
        endpoint: process.env.VELORA_CDP || null,
        handle: "fashion83868888",
        url: null,
        output: resolve(repoRoot, "code-check/tmp/tiktok-profile"),
        timeout: 90_000,
        captureDelayMs: 2500,
        domPollSeconds: 12,
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
            case "--handle": out.handle = next().replace(/^@/, ""); break;
            case "--url": out.url = next(); break;
            case "--output": out.output = resolve(next()); break;
            case "--timeout": out.timeout = Number(next()); break;
            case "--delay": out.captureDelayMs = Number(next()); break;
            case "--poll": out.domPollSeconds = Number(next()); break;
            case "--help":
                console.log("Usage: node profile.mjs [--handle <name>] [--url <profile-url>]");
                process.exit(0);
                break;
            default:
                if (a.startsWith("--")) throw new Error(`Unknown flag: ${a}`);
        }
    }
    if (!out.url) {
        out.url = `https://www.tiktok.com/@${out.handle}?lang=en`;
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

async function waitForCdp(url, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        try {
            if ((await fetch(url)).ok) return;
        } catch (_) {}
        await delay(100);
    }
    throw new Error(`CDP not ready: ${url}`);
}

async function spawnVelora() {
    if (!existsSync(veloraBin)) throw new Error("Run `zig build` first");
    const port = await getFreePort();
    const stderr = [];
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", BROWSER_PROFILE,
        "--log-level", "warn",
    ], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", (c) => stderr.push(c));
    const endpoint = `http://127.0.0.1:${port}`;
    await waitForCdp(`${endpoint}/json/version`);
    return { proc, endpoint, stderr };
}

const EXTRACT_SCRIPT = `(() => {
    const htmlLen = (document.documentElement?.outerHTML || '').length;
    const downgrade = document.querySelector('#app')?.getAttribute('data-downgrade');
    const raw = document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent || '';
    const sigiRaw = document.querySelector('#SIGI_STATE')?.textContent || '';

    const dom = {
        title: document.title || '',
        userTitle: document.querySelector('[data-e2e="user-title"]')?.textContent?.trim() || '',
        userSub: document.querySelector('[data-e2e="user-subtitle"]')?.textContent?.trim() || '',
        followers: document.querySelector('[data-e2e="followers-count"]')?.textContent?.trim() || '',
        postLinks: [...document.querySelectorAll('a[href*="/video/"]')]
            .map((a) => a.href)
            .filter((h, i, arr) => arr.indexOf(h) === i)
            .slice(0, 8),
        textSnippet: (document.body?.innerText || '').slice(0, 500).replace(/\\s+/g, ' ').trim(),
    };

    let universal = null;
    let userDetail = null;
    let parseError = null;
    if (raw) {
        try {
            universal = JSON.parse(raw);
            userDetail = universal?.__DEFAULT_SCOPE__?.['webapp.user-detail'] || null;
        } catch (e) {
            parseError = String(e);
        }
    }

    const user = userDetail?.userInfo?.user || null;
    const stats = userDetail?.userInfo?.stats || null;
    const items = userDetail?.itemList || [];

    const profile = user ? {
        id: user.id,
        uniqueId: user.uniqueId,
        nickname: user.nickname,
        signature: user.signature || '',
        verified: !!user.verified,
        avatar: user.avatarLarger || user.avatarMedium || user.avatarThumb || '',
        stats: stats ? {
            followerCount: stats.followerCount,
            followingCount: stats.followingCount,
            heartCount: stats.heartCount,
            videoCount: stats.videoCount,
        } : null,
        itemListCount: items.length,
        items: items.slice(0, 5).map((it) => ({
            id: it.id,
            desc: (it.desc || '').slice(0, 120),
            createTime: it.createTime,
            playCount: it.stats?.playCount,
        })),
    } : null;

    return {
        htmlLen,
        downgrade,
        universalLen: raw.length,
        sigiLen: sigiRaw.length,
        parseError,
        profile,
        dom,
    };
})()`;

function buildVerdict(handle, snap) {
    const p = snap.profile;
    const handleMatch = p?.uniqueId?.toLowerCase() === handle.toLowerCase();
    const hasStats = !!(p?.stats?.followerCount != null || p?.stats?.videoCount != null);
    const domHasUser = !!snap.dom.userTitle || snap.dom.postLinks.length > 0;
    const passed = handleMatch && hasStats;
    return {
        passed,
        partial: !passed && !!p?.uniqueId,
        handleMatch,
        hasStats,
        domHydrated: domHasUser,
        source: passed ? "universal_data" : domHasUser ? "dom" : p ? "universal_partial" : "none",
    };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    await mkdir(opts.output, { recursive: true });

    let proc = null;
    let stderr = [];
    let endpoint = opts.endpoint;
    if (!endpoint) {
        const s = await spawnVelora();
        proc = s.proc;
        stderr = s.stderr;
        endpoint = s.endpoint;
        console.log(`[velora] ${endpoint}`);
    }

    const browser = await Browser.connect(endpoint);
    const errors = [];
    const t0 = Date.now();

    try {
        const page = await browser.newPage();
        page.session.on("Runtime.exceptionThrown", (e) => {
            errors.push(e?.exceptionDetails?.text ?? "exception");
        });

        console.log(`[goto] ${opts.url}`);
        await page.goto(opts.url, { waitUntil: "load", timeout: opts.timeout });
        await delay(opts.captureDelayMs);

        const early = await page.evaluate(EXTRACT_SCRIPT).catch((e) => ({
            error: String(e),
            profile: null,
            dom: {},
        }));

        const domSnapshots = [];
        const pollEnd = Date.now() + opts.domPollSeconds * 1000;
        while (Date.now() < pollEnd) {
            const snap = await page.evaluate(`(() => ({
                downgrade: document.querySelector('#app')?.getAttribute('data-downgrade'),
                htmlLen: (document.documentElement?.outerHTML || '').length,
                universalLen: (document.querySelector('#__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent || '').length,
                userTitle: document.querySelector('[data-e2e="user-title"]')?.textContent?.trim() || '',
                postLinks: document.querySelectorAll('a[href*="/video/"]').length,
                textLen: (document.body?.innerText || '').length,
            }))()`).catch((e) => ({ error: String(e) }));
            domSnapshots.push({ atMs: Date.now() - t0, ...snap });
            if (snap.userTitle || snap.postLinks > 0) break;
            await delay(2000);
        }

        const handle = opts.handle;
        const verdict = buildVerdict(handle, early);
        const p = early.profile;

        const report = {
            url: opts.url,
            handle,
            profile: BROWSER_PROFILE,
            earlyCapture: early,
            domSnapshots,
            errors,
            durationMs: Date.now() - t0,
            verdict,
            passed: verdict.passed,
            summary: verdict.passed
                ? `Profile ${p.uniqueId} (${p.nickname}) — ${p.stats?.followerCount} followers, ${p.stats?.videoCount} videos`
                : verdict.partial
                    ? `Partial data for ${early.profile?.uniqueId || "?"}`
                    : "Could not extract profile data",
        };

        const html = await page.content().catch(() => "");
        await writeFile(resolve(opts.output, "report.json"), JSON.stringify(report, null, 2));
        await writeFile(resolve(opts.output, "page-early.json"), JSON.stringify(early, null, 2));
        if (html) await writeFile(resolve(opts.output, "page.html"), html);
        if (stderr.length) {
            await writeFile(resolve(opts.output, "velora.log"), Buffer.concat(stderr).toString());
        }

        console.log("\n=== Profile data (SSR capture) ===");
        if (p) {
            console.log(`uniqueId:   ${p.uniqueId}`);
            console.log(`nickname:   ${p.nickname}`);
            console.log(`signature:  ${(p.signature || "").slice(0, 80)}`);
            if (p.stats) {
                console.log(`followers:  ${p.stats.followerCount}`);
                console.log(`following:  ${p.stats.followingCount}`);
                console.log(`likes:      ${p.stats.heartCount}`);
                console.log(`videos:     ${p.stats.videoCount}`);
            }
            console.log(`itemList:   ${p.itemListCount} (in SSR payload)`);
            console.log(`universal:  ${early.universalLen} bytes`);
        } else {
            console.log("no profile in universal data");
            if (early.parseError) console.log(`parse error: ${early.parseError}`);
        }

        console.log("\n=== DOM hydration ===");
        const last = domSnapshots.at(-1) || {};
        console.log(`htmlLen:     ${last.htmlLen ?? early.htmlLen}`);
        console.log(`universal:   ${last.universalLen ?? "?"} bytes remaining`);
        console.log(`downgrade:   ${last.downgrade ?? early.downgrade}`);
        console.log(`userTitle:   ${last.userTitle || early.dom?.userTitle || "(empty)"}`);
        console.log(`video links: ${last.postLinks ?? 0}`);

        console.log(`\n=== Result: ${verdict.passed ? "PASS" : verdict.partial ? "PARTIAL" : "FAIL"} ===`);
        console.log(`saved: ${opts.output}/report.json`);

        await page.close().catch(() => {});
        process.exitCode = verdict.passed ? 0 : verdict.partial ? 1 : 2;
    } finally {
        await browser.close().catch(() => {});
        if (proc) {
            proc.kill("SIGTERM");
            await delay(300);
        }
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});