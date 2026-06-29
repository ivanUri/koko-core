#!/usr/bin/env node
/**
 * Export google.com cookies from Google Chrome → Velora --cookie JSON.
 *
 * Modes:
 *   --chrome-attach     Use CHROME_CDP / --chrome-endpoint (user's running Chrome)
 *   default             Spawn fresh Chrome, visit google.com, export cookies
 *
 *   node google-search-debug/scripts/export-chrome-cookies.mjs
 *   node google-search-debug/scripts/export-chrome-cookies.mjs --chrome-attach
 *   node google-search-debug/scripts/export-chrome-cookies.mjs --out google-search-debug/tmp/chrome-cookies.json
 */
import { mkdir, writeFile, cp, access } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import os from "node:os";

import {
    REPO,
    connectCdp,
    spawnChrome,
    resolveGoogleChromeSession,
    killProc,
} from "../lib/cdp.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function defaultChromeUserData() {
    return process.platform === "darwin"
        ? resolve(os.homedir(), "Library/Application Support/Google/Chrome")
        : process.platform === "win32"
            ? resolve(process.env.LOCALAPPDATA || "", "Google/Chrome/User Data")
            : resolve(os.homedir(), ".config/google-chrome");
}

function parseArgs(argv) {
    const out = {
        out: resolve(REPO, "google-search-debug/tmp/chrome-cookies.json"),
        chromeAttach: false,
        chromeEndpoint: process.env.CHROME_CDP || null,
        chromeUserData: null,
        chromeProfile: "Default",
        seedUrl: "https://www.google.com/",
        maxSec: 20,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--out") out.out = resolve(argv[++i]);
        else if (a === "--chrome-attach") out.chromeAttach = true;
        else if (a === "--chrome-endpoint") out.chromeEndpoint = argv[++i];
        else if (a === "--chrome-user-data") out.chromeUserData = resolve(argv[++i]);
        else if (a === "--chrome-profile") out.chromeProfile = argv[++i];
        else if (a === "--use-my-chrome-profile") out.chromeUserData = defaultChromeUserData();
        else if (a === "--seed-url") out.seedUrl = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
    }
    return out;
}

async function copyChromeProfileForExport(userDataDir, profileName) {
    const stamp = Date.now();
    const tmpRoot = resolve(os.tmpdir(), `velora-chrome-export-${stamp}`);
    const srcProfile = join(userDataDir, profileName);
    const dstProfile = join(tmpRoot, profileName);

    await access(userDataDir);
    await access(srcProfile);

    await mkdir(tmpRoot, { recursive: true });
    await cp(join(userDataDir, "Local State"), join(tmpRoot, "Local State"));
    await cp(srcProfile, dstProfile, {
        recursive: true,
        filter: (src) => {
            const base = src.split("/").pop() || "";
            return ![
                "Cache", "Code Cache", "GPUCache", "Service Worker",
                "SingletonLock", "SingletonSocket", "RunningChromeVersion",
            ].includes(base);
        },
    });

    return tmpRoot;
}

function toVeloraCookie(c) {
    const sameSite = c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None"
        ? c.sameSite
        : "Lax";
    return {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || "/",
        secure: c.secure ?? true,
        httpOnly: c.httpOnly ?? false,
        sameSite,
        ...(c.expires && c.expires > 0 ? { expires: c.expires } : {}),
    };
}

function filterGoogleCookies(cookies) {
    return cookies.filter((c) => {
        const d = String(c.domain || "");
        return d.includes("google.");
    });
}

async function exportCookiesFromEndpoint(endpoint, { seedUrl, maxSec }) {
    const conn = await connectCdp(endpoint);
    const { client, sessionId } = conn;
    const t0 = Date.now();

    try {
        await client.send("Network.enable", {}, sessionId);
        if (seedUrl) {
            await client.send("Page.navigate", { url: seedUrl }, sessionId);
            while (Date.now() - t0 < maxSec * 1000) {
                const { result } = await client.send("Runtime.evaluate", {
                    expression: "document.readyState",
                    returnByValue: true,
                }, sessionId).catch(() => ({ result: { value: "loading" } }));
                if (result?.value === "complete" || result?.value === "interactive") break;
                await delay(200);
            }
            await delay(500);
        }

        const all = await client.send("Network.getAllCookies", {}, sessionId).catch(() => ({ cookies: [] }));
        const scoped = await client.send("Network.getCookies", {
            urls: ["https://www.google.com", "https://google.com", "https://www.google.com.vn"],
        }, sessionId).catch(() => ({ cookies: [] }));

        const merged = new Map();
        for (const c of [...(all.cookies || []), ...(scoped.cookies || [])]) {
            const key = `${c.domain}\0${c.path}\0${c.name}`;
            merged.set(key, c);
        }

        const google = filterGoogleCookies([...merged.values()]);
        return {
            endpoint,
            seedUrl,
            totalAll: all.cookies?.length ?? 0,
            totalGoogle: google.length,
            cookieNames: google.map((c) => c.name).sort(),
            cookies: google.map(toVeloraCookie),
        };
    } finally {
        client.close();
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    let chromeProc = null;
    let chromeSpawned = false;

    try {
        let chromeSession;
        if (args.chromeUserData) {
            const profileDir = await copyChromeProfileForExport(args.chromeUserData, args.chromeProfile);
            console.log(`[profile] copied ${args.chromeUserData}/${args.chromeProfile} → ${profileDir}`);
            chromeSession = await spawnChrome({ profileDir });
            chromeProc = chromeSession.proc;
            chromeSpawned = true;
        } else {
            chromeSession = await resolveGoogleChromeSession({
                spawn: !args.chromeAttach,
                attachEndpoint: args.chromeEndpoint,
                profileDir: `/tmp/velora-cookie-export-chrome-${Date.now()}`,
            });
            chromeProc = chromeSession.proc;
            chromeSpawned = chromeSession.spawned;
        }

        console.log(`[chrome] ${chromeSpawned ? "spawned" : "attach"} ${chromeSession.endpoint}`);
        console.log(`[seed]   ${args.seedUrl}`);

        const result = await exportCookiesFromEndpoint(chromeSession.endpoint, {
            seedUrl: args.seedUrl,
            maxSec: args.maxSec,
        });

        await mkdir(dirname(args.out), { recursive: true });
        await writeFile(args.out, JSON.stringify(result.cookies, null, 2));

        console.log(`\nExported ${result.totalGoogle} google cookies (of ${result.totalAll} total)`);
        console.log(`Names: ${result.cookieNames.join(", ") || "(none)"}`);
        console.log(`Saved: ${args.out}`);
    } finally {
        if (chromeSpawned) killProc(chromeProc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });