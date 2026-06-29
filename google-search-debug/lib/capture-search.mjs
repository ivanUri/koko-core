/**
 * Capture a single Google Search navigation via raw CDP.
 */
import { readFileSync } from "node:fs";

import {
    connectCdp,
    INJECT_FP_PATH,
} from "./cdp.mjs";
import {
    analyzeUrl,
    analyzeGoogleSignals,
    summarizeNetwork,
    EXTRACT_DOM,
    READ_FP_LOGS,
    READ_LOCATION,
} from "./parse-serp.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function hostFromUrl(url) {
    try { return new URL(url).host; } catch { return null; }
}

function pathFromUrl(url) {
    try { return new URL(url).pathname; } catch { return null; }
}

async function evaluate(client, sessionId, expression, timeoutMs = 8000) {
    const result = await Promise.race([
        client.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: false,
        }, sessionId),
        delay(timeoutMs).then(() => ({ timedOut: true })),
    ]);
    if (result?.timedOut) return { error: "evaluate_timeout" };
    if (result?.exceptionDetails) return { error: result.exceptionDetails.text || "evaluate_failed" };
    return { value: result.result?.value };
}

export async function captureGoogleSearch({
    endpoint,
    url,
    label,
    maxSec = 60,
    injectFingerprint = true,
}) {
    const t0 = Date.now();
    const requests = [];
    const responses = new Map();
    const consoleLines = [];
    const exceptions = [];
    const fpLogs = [];
    let documentResponse = null;

    const conn = await connectCdp(endpoint);
    const { client, sessionId } = conn;

    const onEvent = (msg) => {
        if (msg.sessionId && msg.sessionId !== sessionId) return;
        const p = msg.params || {};
        if (msg.method === "Network.requestWillBeSent") {
            requests.push({
                requestId: p.requestId,
                url: p.request?.url,
                host: hostFromUrl(p.request?.url),
                path: pathFromUrl(p.request?.url),
                type: p.type,
                method: p.request?.method,
                ts: p.timestamp,
            });
        }
        if (msg.method === "Network.responseReceived") {
            const r = p.response || {};
            responses.set(p.requestId, {
                status: r.status,
                protocol: r.protocol,
                mimeType: r.mimeType,
                url: r.url,
            });
            if (p.type === "Document" && r.url?.includes("google.com")) {
                documentResponse = {
                    requestId: p.requestId,
                    status: r.status,
                    protocol: r.protocol,
                    url: r.url,
                };
            }
        }
        if (msg.method === "Runtime.consoleAPICalled") {
            const args = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(" ");
            consoleLines.push({ type: p.type, text: args.slice(0, 500) });
        }
        if (msg.method === "Runtime.exceptionThrown") {
            const d = p.exceptionDetails || {};
            const text = d.text || d.exception?.description || "exception";
            exceptions.push({
                text: String(text).slice(0, 500),
                url: d.url || null,
                line: d.lineNumber,
                col: d.columnNumber,
            });
        }
    };

    client.ws.on("message", (raw) => {
        try {
            onEvent(JSON.parse(String(raw)));
        } catch {}
    });

    try {
        if (injectFingerprint) {
            const source = readFileSync(INJECT_FP_PATH, "utf8");
            await client.send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
        }
        await client.send("Network.enable", {}, sessionId);
        await client.send("Runtime.enable", {}, sessionId);
        await client.send("Page.enable", {}, sessionId);

        await client.send("Page.navigate", { url }, sessionId);

        let finalUrl = url;
        let dom = null;
        const deadline = t0 + maxSec * 1000;

        while (Date.now() < deadline) {
            await delay(500);
            const loc = await evaluate(client, sessionId, READ_LOCATION, 5000);
            if (loc.value?.href) finalUrl = loc.value.href;

            const u = analyzeUrl(finalUrl);
            const stable = loc.value?.readyState === "complete"
                && (u.isSorry || u.hasSgSs || dom?.hasSearchResults || dom?.hasCaptcha);

            if (!dom || Date.now() - t0 > 3000) {
                const d = await evaluate(client, sessionId, EXTRACT_DOM, 8000);
                if (d.value) dom = d.value;
            }

            if (stable) break;
            if (Date.now() - t0 > 8000 && u.isSorry) break;
        }

        if (!dom) {
            const d = await evaluate(client, sessionId, EXTRACT_DOM, 8000);
            if (d.value) dom = d.value;
        }

        const fp = await evaluate(client, sessionId, READ_FP_LOGS, 5000);
        if (Array.isArray(fp.value)) fpLogs.push(...fp.value);

        const htmlRes = await evaluate(client, sessionId, `(() => document.documentElement.outerHTML)()`, 15000);
        const html = htmlRes.value || "";

        for (const req of requests) {
            const res = responses.get(req.requestId);
            if (res) Object.assign(req, res);
        }

        const serp = analyzeUrl(finalUrl);
        const googleSignals = analyzeGoogleSignals({ html, network: requests, consoleLines, exceptions });
        return {
            label,
            endpoint,
            startUrl: url,
            finalUrl,
            elapsedMs: Date.now() - t0,
            serp,
            document: documentResponse,
            dom,
            network: requests,
            networkSummary: summarizeNetwork(requests),
            consoleLines,
            exceptions,
            googleSignals,
            fpLogs,
            htmlLen: html.length,
            html,
        };
    } finally {
        client.close();
    }
}