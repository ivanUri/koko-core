#!/usr/bin/env node
/** Bisect abort-signal-any WPT crashes by running increasing subsets via data URL. */
import WebSocket from "ws";
import { fetchWithTimeout, parseMaxSecArg } from "./lib/cdp-probe-budget.mjs";

const CDP = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const maxSec = parseMaxSecArg(process.argv, 15);

const SUBSETS = [
    { name: "signal-only", body: "abortSignalAnySignalOnlyTests(AbortSignal);" },
    { name: "through-test-2", body: `
abortSignalAnySignalOnlyTests(AbortSignal);
(function() {
  const SI = AbortSignal, CI = AbortController;
  const desc = SI.name + '.any()';
  const suffix = '(using ' + CI.name + ')';
  test(t => {
    const c = new CI(); const s = c.signal;
    const clone = SI.any([s]);
    let f = false;
    clone.onabort = t.step_func(() => { f = true; });
    c.abort('reason string');
    assert_true(f);
  }, desc + ' follows a single signal ' + suffix);
})();` },
    { name: "full", body: `
abortSignalAnySignalOnlyTests(AbortSignal);
abortSignalAnyTests(AbortSignal, AbortController);` },
];

function dataUrl(subset) {
    const html = `<!doctype html><meta charset=utf-8>
<script src="http://localhost:8000/resources/testharness.js"></script>
<script src="http://localhost:8000/resources/testharnessreport.js"></script>
<script src="http://localhost:8000/dom/abort/resources/abort-signal-any-tests.js"></script>
<script>${subset.body}</script>`;
    return "data:text/html," + encodeURIComponent(html);
}

async function runSubset(wsUrl, subset) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let id = 0;
        const pending = new Map();
        let sessionId = null;
        let sawCrash = false;

        ws.on("message", (raw) => {
            const msg = JSON.parse(raw);
            if (msg.method === "Runtime.exceptionThrown") {
                console.error("  exception:", msg.params?.exceptionDetails?.text);
            }
            if (msg.id && pending.has(msg.id)) {
                const { resolve: res, reject: rej } = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) rej(new Error(JSON.stringify(msg.error)));
                else res(msg.result);
            }
        });
        ws.on("close", () => { if (!sawCrash) { sawCrash = true; resolve("ws_closed"); } });
        ws.on("error", (e) => reject(e));

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
                console.log(`\n[${subset.name}] navigate`);
                await call("Page.navigate", { url: dataUrl(subset) });
                await new Promise((r) => setTimeout(r, maxSec * 1000));
                ws.close();
                resolve("timeout_ok");
            } catch (e) {
                resolve("error:" + e.message);
            }
        });
    });
}

async function main() {
    const ver = await fetchWithTimeout(`${CDP}/json/version`);
    const { webSocketDebuggerUrl } = await ver.json();

    for (const subset of SUBSETS) {
        try {
            await fetchWithTimeout(`${CDP}/json/version`, 2000);
        } catch {
            console.error(`Velora dead before subset ${subset.name}`);
            break;
        }
        const result = await runSubset(webSocketDebuggerUrl, subset);
        let alive = true;
        try {
            await fetchWithTimeout(`${CDP}/json/version`, 2000);
        } catch {
            alive = false;
        }
        console.log(`[${subset.name}] result=${result} velora_alive=${alive}`);
        if (!alive) break;
    }
}

main().catch((e) => { console.error(e); process.exit(1); });