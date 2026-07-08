#!/usr/bin/env node
/**
 * Probe AbortSignal.any() cases from abort-signal-any WPT one at a time.
 * Usage: node scripts/cdp-abort-signal-any-probe.mjs [--case N] [--max-sec 20]
 */
import WebSocket from "ws";
import {
    DEFAULT_MAX_SEC,
    fetchWithTimeout,
    parseMaxSecArg,
    createProbeBudget,
} from "./lib/cdp-probe-budget.mjs";

const CDP = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const maxSec = parseMaxSecArg(process.argv);
const caseArg = process.argv.includes("--case")
    ? Number(process.argv[process.argv.indexOf("--case") + 1])
    : null;

const CASES = [
    {
        name: "empty array",
        js: `(() => { const s = AbortSignal.any([]); return !s.aborted; })()`,
    },
    {
        name: "follow single signal",
        js: `(() => {
            const c = new AbortController();
            const clone = AbortSignal.any([c.signal]);
            let fired = false;
            clone.onabort = () => { fired = true; };
            c.abort("reason string");
            return clone.aborted && fired && clone.reason === "reason string";
        })()`,
    },
    {
        name: "multiple signals",
        js: `(() => {
            const cs = [new AbortController(), new AbortController(), new AbortController()];
            const combined = AbortSignal.any(cs.map(c => c.signal));
            let fired = false;
            combined.onabort = () => { fired = true; };
            cs[1].abort();
            return fired && combined.aborted && combined.reason instanceof DOMException && combined.reason.name === "AbortError";
        })()`,
    },
    {
        name: "already aborted",
        js: `(() => {
            const cs = [new AbortController(), new AbortController(), new AbortController()];
            cs[1].abort("reason 1");
            cs[2].abort("reason 2");
            const s = AbortSignal.any(cs.map(c => c.signal));
            return s.aborted && s.reason === "reason 1";
        })()`,
    },
    {
        name: "duplicate same signal",
        js: `(() => {
            const c = new AbortController();
            const s = AbortSignal.any([c.signal, c.signal]);
            c.abort("reason");
            return s.aborted && s.reason === "reason";
        })()`,
    },
    {
        name: "composable",
        js: `(() => {
            const cs = [new AbortController(), new AbortController(), new AbortController()];
            const c1 = AbortSignal.any([cs[0].signal, cs[1].signal]);
            const c2 = AbortSignal.any([c1, cs[2].signal]);
            let fired = false;
            c2.onabort = () => { fired = true; };
            cs[2].abort();
            return fired && c2.aborted;
        })()`,
    },
    {
        name: "event order 01234",
        js: `(() => {
            const c = new AbortController();
            const signals = [];
            signals.push(c.signal);
            signals.push(AbortSignal.any([c.signal]));
            signals.push(AbortSignal.any([c.signal]));
            signals.push(AbortSignal.any([signals[0]]));
            signals.push(AbortSignal.any([signals[1]]));
            let result = "";
            for (let i = 0; i < signals.length; i++) {
                signals[i].addEventListener("abort", () => { result += i; });
            }
            c.abort();
            return result === "01234";
        })()`,
    },
    {
        name: "reentrant createAny in listener",
        js: `(() => {
            const c = new AbortController();
            const s1 = AbortSignal.any([c.signal]);
            const s2 = AbortSignal.any([s1]);
            let fired = false;
            c.signal.addEventListener("abort", () => {
                const s3 = AbortSignal.any([s2]);
                fired = c.signal.aborted && s1.aborted && s2.aborted && s3.aborted;
            });
            c.abort();
            return fired;
        })()`,
    },
    {
        name: "reentrant abort",
        js: `(() => {
            const c1 = new AbortController();
            const c2 = new AbortController();
            const s = AbortSignal.any([c1.signal, c2.signal]);
            let count = 0;
            c1.signal.addEventListener("abort", () => { c2.abort("reason 2"); });
            s.addEventListener("abort", () => { count++; });
            c1.abort("reason 1");
            return count === 1 && s.aborted && s.reason === "reason 1";
        })()`,
    },
    {
        name: "shared DOMException aborted source",
        js: `(() => {
            const source = AbortSignal.abort();
            const dep = AbortSignal.any([source]);
            return source.reason instanceof DOMException && source.reason === dep.reason;
        })()`,
    },
    {
        name: "shared DOMException abort later",
        js: `(() => {
            const c = new AbortController();
            const source = c.signal;
            const dep = AbortSignal.any([source]);
            c.abort();
            return source.reason instanceof DOMException && source.reason === dep.reason;
        })()`,
    },
    {
        name: "intermediate signals",
        js: `(() => {
            const c = new AbortController();
            let combined = AbortSignal.any([c.signal]);
            combined = AbortSignal.any([combined]);
            combined = AbortSignal.any([combined]);
            combined = AbortSignal.any([combined]);
            let fired = false;
            combined.onabort = () => { fired = true; };
            c.abort("the reason");
            return fired && combined.aborted && combined.reason === "the reason";
        })()`,
    },
    {
        name: "async timeout+any",
        js: `(async () => {
            const c = new AbortController();
            const timeoutSignal = AbortSignal.timeout(5);
            const combined = AbortSignal.any([c.signal, timeoutSignal]);
            return await new Promise((resolve) => {
                combined.onabort = () => {
                    resolve(combined.aborted &&
                        combined.reason instanceof DOMException &&
                        combined.reason.name === "TimeoutError");
                };
            });
        })()`,
        awaitPromise: true,
    },
];

async function cdp(wsUrl, send) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let id = 0;
        const pending = new Map();
        ws.on("message", (raw) => {
            const msg = JSON.parse(raw);
            if (msg.id && pending.has(msg.id)) {
                const { resolve: res, reject: rej } = pending.get(msg.id);
                pending.delete(msg.id);
                if (msg.error) rej(new Error(JSON.stringify(msg.error)));
                else res(msg.result);
            }
        });
        ws.on("open", async () => {
            try {
                resolve({
                    call: (method, params = {}) =>
                        new Promise((res, rej) => {
                            const mid = ++id;
                            pending.set(mid, { resolve: res, reject: rej });
                            ws.send(JSON.stringify({ id: mid, method, params }));
                        }),
                    close: () => ws.close(),
                });
            } catch (e) {
                reject(e);
            }
        });
        ws.on("error", reject);
    });
}

async function main() {
    const budget = createProbeBudget(maxSec, () => {});
    try {
        const ver = await fetchWithTimeout(`${CDP}/json/version`);
        const { webSocketDebuggerUrl } = await ver.json();
        const { call, close } = await cdp(webSocketDebuggerUrl);

        const { targetId } = await call("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await call("Target.attachToTarget", {
            targetId,
            flatten: true,
        });

        const run = (method, params = {}) =>
            call(method, { ...params, sessionId });

        await run("Runtime.enable");
        await run("Page.enable");

        const indices = caseArg != null ? [caseArg] : CASES.map((_, i) => i);

        for (const i of indices) {
            const c = CASES[i];
            if (!c) {
                console.error(`Unknown case ${i}`);
                process.exit(1);
            }
            console.log(`\n=== Case ${i}: ${c.name} ===`);
            try {
                const { result, exceptionDetails } = await run("Runtime.evaluate", {
                    expression: c.js,
                    returnByValue: true,
                    awaitPromise: c.awaitPromise ?? true,
                });
                if (exceptionDetails) {
                    console.error("EXCEPTION:", JSON.stringify(exceptionDetails, null, 2));
                } else {
                    console.log("result:", result?.value);
                }
            } catch (e) {
                console.error("CDP error (velora may have crashed):", e.message);
                process.exit(2);
            }
        }

        close();
        budget.clear();
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

main();