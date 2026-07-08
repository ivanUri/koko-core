#!/usr/bin/env node
/**
 * Bisect abort-signal-any WPT crash by skipping named tests.
 * Usage:
 *   node scripts/cdp-abort-signal-any-wpt-bisect.mjs           # full (expect crash)
 *   node scripts/cdp-abort-signal-any-wpt-bisect.mjs --skip intermediate
 *   node scripts/cdp-abort-signal-any-wpt-bisect.mjs --only intermediate
 */
import fs from "fs";
import path from "path";
import WebSocket from "ws";
import { fileURLToPath } from "url";
import { fetchWithTimeout, parseMaxSecArg } from "./lib/cdp-probe-budget.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BISECT_DIR = path.join(ROOT, "wpt/dom/abort/_bisect");
const CDP = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const maxSec = parseMaxSecArg(process.argv, 10);

function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : null;
}

const skipKey = argValue("--skip");
const onlyKey = argValue("--only");

const KEYS = {
    intermediate: "works with intermediate signals",
    "event-order": "fire in the right order",
    "reentrant-create": "marked aborted before abort events fire",
    "reentrant-abort": "reentrant aborts",
    "shared-aborted": "already aborted source",
    "shared-later": "being aborted later",
    composable: "composable",
    async: "AbortSignal.timeout",
};

function buildJs() {
    const filter = skipKey ? KEYS[skipKey] : onlyKey ? KEYS[onlyKey] : null;
    const mode = skipKey ? "skip" : onlyKey ? "only" : "full";

    if (mode === "full") {
        return `abortSignalAnySignalOnlyTests(AbortSignal);
abortSignalAnyTests(AbortSignal, AbortController);`;
    }

    return `abortSignalAnySignalOnlyTests(AbortSignal);
(function() {
  const needle = ${JSON.stringify(filter)};
  const mode = ${JSON.stringify(mode)};
  const _test = test;
  const _async = async_test;
  const match = (title) => title && title.includes(needle);
  test = function(fn, title, props) {
    if (mode === "skip" && match(title)) return;
    if (mode === "only" && !match(title)) return;
    return _test(fn, title, props);
  };
  async_test = function(fn, title, props) {
    if (mode === "skip" && match(title)) return;
    if (mode === "only" && !match(title)) return;
    return _async(fn, title, props);
  };
  abortSignalAnyTests(AbortSignal, AbortController);
})();`;
}

function writePage(name, js) {
    fs.mkdirSync(BISECT_DIR, { recursive: true });
    const html = `<!doctype html><meta charset=utf-8>
<script src="/resources/testharness.js"></script>
<script src="/resources/testharnessreport.js"></script>
<script src="/dom/abort/resources/abort-signal-any-tests.js"></script>
<div id=log></div>
<script>${js}</script>`;
    fs.writeFileSync(path.join(BISECT_DIR, `${name}.html`), html);
    return `http://localhost:8000/dom/abort/_bisect/${name}.html`;
}

async function probe(url) {
    const ver = await fetchWithTimeout(`${CDP}/json/version`);
    const { webSocketDebuggerUrl } = await ver.json();
    return new Promise((resolve) => {
        const ws = new WebSocket(webSocketDebuggerUrl);
        let id = 0;
        const pending = new Map();
        let sessionId = null;
        ws.on("message", (raw) => {
            const msg = JSON.parse(raw);
            if (msg.id && pending.has(msg.id)) {
                const { resolve: res, reject: rej } = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) rej(new Error(JSON.stringify(msg.error)));
                else res(msg.result);
            }
        });
        const call = (method, params = {}) =>
            new Promise((res, rej) => {
                const mid = ++id;
                pending.set(mid, { resolve: res, reject: rej });
                ws.send(JSON.stringify({ id: mid, method, params: { ...params, sessionId } }));
            });
        ws.on("open", async () => {
            try {
                const { targetId } = await call("Target.createTarget", { url: "about:blank" });
                ({ sessionId } = await call("Target.attachToTarget", { targetId, flatten: true }));
                await call("Runtime.enable");
                await call("Page.enable");
                await call("Page.navigate", { url });
                await new Promise((r) => setTimeout(r, maxSec * 1000));
                ws.close();
                resolve("done");
            } catch (e) {
                ws.close();
                resolve("error:" + e.message);
            }
        });
        ws.on("error", () => resolve("ws_error"));
    });
}

async function alive() {
    try {
        await fetchWithTimeout(`${CDP}/json/version`, 1500);
        return true;
    } catch {
        return false;
    }
}

async function runCase(label, js) {
    if (!(await alive())) {
        console.log(`${label}: velora already dead`);
        return false;
    }
    const url = writePage(label, js);
    console.log(`${label} -> ${url}`);
    await probe(url);
    const ok = await alive();
    console.log(`${label}: alive=${ok}`);
    return ok;
}

async function main() {
    if (skipKey || onlyKey) {
        const name = skipKey ? `skip-${skipKey}` : `only-${onlyKey}`;
        const ok = await runCase(name, buildJs());
        process.exit(ok ? 0 : 2);
    }

    // Auto bisect: full then skip each late test
    console.log("=== full ===");
    if (!(await runCase("full", buildJs()))) return;

}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});