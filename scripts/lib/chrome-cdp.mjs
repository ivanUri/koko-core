/**
 * Real Chrome via CDP (no Playwright).
 *
 * Prerequisite — start Chrome once:
 *   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
 *
 * Env:
 *   CHROME_CDP=http://127.0.0.1:9222
 *   CHROME_BIN=/path/to/Google Chrome
 */
import { spawn } from "node:child_process";
import { Browser } from "../../sdk/dist/index.js";

export const CHROME_BIN = process.env.CHROME_BIN
    || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
export const DEFAULT_ENDPOINT = process.env.CHROME_CDP || "http://127.0.0.1:9222";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export function normalizeEndpoint(endpoint) {
    return String(endpoint || DEFAULT_ENDPOINT).replace(/\/$/, "");
}

export async function cdpReady(endpoint = DEFAULT_ENDPOINT) {
    try {
        return (await fetch(`${normalizeEndpoint(endpoint)}/json/version`)).ok;
    } catch {
        return false;
    }
}

export function chromeStartHint(port = 9222) {
    return `Start real Chrome with remote debugging:\n  "${CHROME_BIN}" --remote-debugging-port=${port}`;
}

/** Launch a dedicated Chrome instance (separate user-data-dir). */
export async function spawnChrome(opts = {}) {
    const port = Number(opts.port ?? 9222);
    const endpoint = `http://127.0.0.1:${port}`;
    const profile = opts.profileDir || `/tmp/velora-chrome-cdp-${port}`;
    const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        "--no-first-run",
        "--no-default-browser-check",
    ];
    if (opts.url) args.push(String(opts.url));

    const proc = spawn(CHROME_BIN, args, { stdio: "ignore", detached: true });
    proc.unref();

    for (let i = 0; i < 60; i++) {
        if (await cdpReady(endpoint)) {
            return { proc, endpoint, profile, port };
        }
        await delay(200);
    }
    throw new Error(`Chrome CDP not ready after spawn: ${endpoint}\n${chromeStartHint(port)}`);
}

/**
 * Connect to real Chrome CDP endpoint.
 * @param {{ endpoint?: string, spawn?: boolean, port?: number }} opts
 */
export async function connectChrome(opts = {}) {
    let endpoint = normalizeEndpoint(opts.endpoint || DEFAULT_ENDPOINT);
    let spawned = null;

    if (!(await cdpReady(endpoint))) {
        if (opts.spawn) {
            const port = opts.port ?? Number(new URL(endpoint).port || 9222);
            spawned = await spawnChrome({ port, profileDir: opts.profileDir });
            endpoint = spawned.endpoint;
        } else {
            throw new Error(`Chrome CDP not reachable: ${endpoint}\n${chromeStartHint()}`);
        }
    }

    const browser = await Browser.connect(endpoint);

    const cleanup = async ({ closePage = true } = {}) => {
        if (closePage) await browser.close().catch(() => undefined);
    };

    return { browser, endpoint, spawned, cleanup };
}

/** @param {import("../../sdk/dist/browser/page.js").Page} page */
export async function pageUrl(page) {
    return page.evaluate(() => location.href);
}

/**
 * Open a fresh tab in real Chrome, run fn, close tab.
 * @param {(ctx: { page, session, browser, endpoint }) => Promise<any>} fn
 */
export async function withChromePage(fn, opts = {}) {
    const { browser, endpoint, cleanup } = await connectChrome(opts);
    const page = await browser.newPage();
    try {
        return await fn({ page, session: page.session, browser, endpoint });
    } finally {
        await page.close().catch(() => undefined);
        if (!opts.keepBrowser) await cleanup({ closePage: true });
    }
}