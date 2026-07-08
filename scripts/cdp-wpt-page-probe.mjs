#!/usr/bin/env node
import WebSocket from "ws";
import { fetchWithTimeout, parseMaxSecArg, createProbeBudget } from "./lib/cdp-probe-budget.mjs";

const CDP = process.env.CDP_URL ?? "http://127.0.0.1:9222";
const url = process.argv[2] ?? "http://localhost:8000/dom/abort/abort-signal-any.any.html";
const maxSec = parseMaxSecArg(process.argv, 30);

async function main() {
    const budget = createProbeBudget(maxSec, () => {});
    const ver = await fetchWithTimeout(`${CDP}/json/version`);
    const { webSocketDebuggerUrl } = await ver.json();

    await new Promise((resolve, reject) => {
        const ws = new WebSocket(webSocketDebuggerUrl);
        let id = 0;
        const pending = new Map();
        let sessionId = null;

        ws.on("message", (raw) => {
            const msg = JSON.parse(raw);
            if (msg.method === "Runtime.consoleAPICalled") {
                const args = msg.params?.args?.map((a) => a.value ?? a.description) ?? [];
                console.log("[console]", ...args);
            }
            if (msg.method === "Runtime.exceptionThrown") {
                console.error("[exception]", JSON.stringify(msg.params, null, 2));
            }
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
                console.log("navigating to", url);
                await call("Page.navigate", { url });
                await new Promise((r) => setTimeout(r, maxSec * 1000));
                console.log("done waiting");
                ws.close();
                resolve();
            } catch (e) {
                reject(e);
            }
        });
        ws.on("error", reject);
    });
    budget.clear();
}

main().catch((e) => {
    console.error("probe failed:", e.message);
    process.exit(2);
});