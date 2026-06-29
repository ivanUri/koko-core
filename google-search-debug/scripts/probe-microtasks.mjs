#!/usr/bin/env node
import { REPO, buildSearchUrl, connectCdp, getFreePort, spawnVelora, killProc } from "../lib/cdp.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function evalExpr(client, sessionId, expression) {
    const res = await client.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        timeout: 30000,
    }, sessionId);
    return res.result?.value ?? { err: res.exceptionDetails?.text };
}

async function main() {
    const port = await getFreePort();
    const launch = await spawnVelora("chrome-local-huys-macbook-pro", port);
    const { client, sessionId } = await connectCdp(launch.endpoint);
    try {
        await client.send("Page.navigate", { url: buildSearchUrl("test") }, sessionId);
        await delay(25000);
        const phases = [];
        phases.push({ step: "immediate", v: await evalExpr(client, sessionId, `({kn:typeof globalThis.knitsail,sn:window.google?.sn})`) });
        phases.push({ step: "after-microtask", v: await evalExpr(client, sessionId, `(async()=>{await Promise.resolve();await Promise.resolve();return {kn:typeof globalThis.knitsail,sn:window.google?.sn}})()`) });
        phases.push({ step: "after-settimeout-0", v: await evalExpr(client, sessionId, `(async()=>{await new Promise(r=>setTimeout(r,0));return {kn:typeof globalThis.knitsail,sn:window.google?.sn}})()`) });
        phases.push({ step: "after-settimeout-100", v: await evalExpr(client, sessionId, `(async()=>{await new Promise(r=>setTimeout(r,100));return {kn:typeof globalThis.knitsail,sn:window.google?.sn}})()`) });
        console.log(JSON.stringify(phases, null, 2));
    } finally {
        client.close();
        killProc(launch.proc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });