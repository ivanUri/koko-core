#!/usr/bin/env node
/**
 * Dual diagnostic: worker protocol vs iframe collector (Fingerprint agent patterns).
 * Runs isolated probes on about:blank, then on playground with hooks.
 */
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
const OUT = resolve(repoRoot, "code-check/tmp/fingerprint-dual");
const PLAYGROUND = "https://demo.fingerprint.com/playground";

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

async function spawnVelora() {
    const port = await getFreePort();
    const args = ["serve", "--host", "127.0.0.1", "--port", String(port), "--log-level", "info", "--log-format", "pretty"];
    args.push("--browser-profile", "chrome-macos-catalina");
    const stderr = [];
    const proc = spawn(veloraBin, args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    proc.stderr.on("data", (c) => stderr.push(c));
    const endpoint = `http://127.0.0.1:${port}`;
    await waitForCdp(`${endpoint}/json/version`);
    return { proc, endpoint, stderr };
}

// Minimal FP worker bootstrap (posts [2], handles 0->1, 3->4, 6->7, 9->10)
const FP_WORKER_BODY = `
function post(G,...B){G.postMessage(B);}
self.addEventListener("message",async({data:X})=>{
  if(X instanceof Array)switch(X[0]){
    case 0: post(self,1); break;
    case 3: post(self,4); break;
    case 6: post(self,7,{probe:"ok",n:42}); break;
    case 9: post(self,10); break;
  }
});
post(self,2);
`;

const dualProbeSource = `async () => {
    const ts = () => Date.now();
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function describeData(d) {
        if (d == null) return { kind: "null" };
        const isArr = d instanceof Array;
        const isArrayLike = !isArr && typeof d === "object" && d !== null && typeof d.length === "number";
        let type0 = undefined;
        try { type0 = d[0]; } catch (e) { type0 = "ERR:" + e; }
        return {
            kind: isArr ? "Array" : (isArrayLike ? "ArrayLike" : typeof d),
            isArray: isArr,
            isArrayLike,
            type0,
            length: isArr || isArrayLike ? d.length : undefined,
            keys: (!isArr && typeof d === "object" && d) ? Object.keys(d).slice(0, 8) : undefined,
        };
    }

    function waitWorkerMsg(worker, codes, label, timeoutMs = 8000) {
        return new Promise((resolve, reject) => {
            const want = new Set(codes);
            const log = [];
            const timer = setTimeout(() => {
                worker.removeEventListener("message", onMsg);
                reject(new Error(label + ": timeout waiting for " + JSON.stringify(codes) + ", log=" + JSON.stringify(log)));
            }, timeoutMs);
            const onMsg = (e) => {
                const info = { t: ts(), dir: "in", ...describeData(e.data) };
                log.push(info);
                const d = e.data;
                if (d instanceof Array && want.has(d[0])) {
                    clearTimeout(timer);
                    worker.removeEventListener("message", onMsg);
                    resolve({ data: d, log });
                }
            };
            worker.addEventListener("message", onMsg);
        });
    }

    async function testWorkerProtocol() {
        const trace = [];
        const push = (o) => { trace.push({ t: ts(), ...o }); };

        const blob = new Blob([${JSON.stringify(FP_WORKER_BODY)}], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);
        let worker;
        try {
            worker = new Worker(url);
        } catch (e) {
            return { ok: false, stage: "construct", error: String(e), trace };
        }

        try {
            const init = await waitWorkerMsg(worker, [2], "init");
            push({ stage: "init", ok: true, data0: init.data[0], log: init.log });

            worker.postMessage([0]);
            push({ stage: "send_0", dir: "out", data: [0] });

            const after0 = await waitWorkerMsg(worker, [1, 2], "after_0");
            push({ stage: "after_0", ok: true, data0: after0.data[0], log: after0.log });

            worker.postMessage([3, { modules: {} }]);
            push({ stage: "send_3", dir: "out", data: [3, "{modules}"] });

            const after3 = await waitWorkerMsg(worker, [4, 5], "after_3");
            push({ stage: "after_3", ok: true, data0: after3.data[0], log: after3.log });

            worker.postMessage([6]);
            push({ stage: "send_6", dir: "out", data: [6] });

            const after6 = await waitWorkerMsg(worker, [7, 8], "after_6");
            push({ stage: "after_6", ok: true, data0: after6.data[0], payload: after6.data[1], log: after6.log });

            worker.postMessage([9]);
            const after9 = await waitWorkerMsg(worker, [10], "after_9");
            push({ stage: "after_9", ok: true, data0: after9.data[0], log: after9.log });

            worker.terminate();
            URL.revokeObjectURL(url);
            return { ok: true, trace };
        } catch (e) {
            push({ stage: "error", error: String(e) });
            try { worker?.terminate(); } catch (_) {}
            try { URL.revokeObjectURL(url); } catch (_) {}
            return { ok: false, trace, error: String(e) };
        }
    }

    async function testIframeCollector() {
        const trace = [];
        const push = (o) => { trace.push({ t: ts(), ...o }); };

        let parentBodyWaits = 0;
        while (!document.body) {
            parentBodyWaits++;
            if (parentBodyWaits > 200) break;
            await sleep(10);
        }
        push({ stage: "parent_body", ok: !!document.body, waits: parentBodyWaits });

        const iframe = document.createElement("iframe");
        const style = iframe.style;
        style.setProperty("display", "block", "important");
        style.position = "absolute";
        style.top = "0";
        style.left = "0";
        style.visibility = "hidden";

        let onloadFired = false;
        let pollCount = 0;

        await new Promise((resolve, reject) => {
            let settled = false;
            const finish = (why) => {
                if (settled) return;
                settled = true;
                push({ stage: "iframe_ready_promise", why });
                resolve();
            };
            iframe.onload = () => { onloadFired = true; finish("onload"); };
            iframe.onerror = (e) => { settled = true; reject(new Error("iframe onerror: " + e)); };
            iframe.src = "about:blank";
            document.body.appendChild(iframe);

            const poll = () => {
                pollCount++;
                const cw = iframe.contentWindow;
                const doc = cw?.document;
                const rs = doc?.readyState;
                const body = doc?.body;
                if (pollCount <= 30 || pollCount % 10 === 0) {
                    push({
                        stage: "poll",
                        n: pollCount,
                        contentWindow: cw === null ? "null" : (cw === undefined ? "undefined" : "ok"),
                        readyState: rs ?? null,
                        hasBody: !!body,
                        onloadFired,
                    });
                }
                if (!onloadFired && rs === "complete") finish("readyState_complete");
                else setTimeout(poll, 10);
            };
            poll();
            setTimeout(() => finish("timeout_3s"), 3000);
        });

        let bodyWaits = 0;
        while (!(iframe.contentWindow?.document?.body)) {
            bodyWaits++;
            if (bodyWaits > 100) break;
            await sleep(50);
        }

        const final = {
            contentWindow: iframe.contentWindow == null ? "null" : "ok",
            readyState: iframe.contentWindow?.document?.readyState ?? null,
            hasBody: !!iframe.contentWindow?.document?.body,
            bodyTag: iframe.contentWindow?.document?.body?.tagName ?? null,
            bodyWaits,
            onloadFired,
            pollCount,
        };
        push({ stage: "final", ...final });

        iframe.parentNode?.removeChild(iframe);
        return { ok: final.hasBody && final.readyState === "complete", trace, final };
    }

    async function testDgRace() {
        // Reproduce SB order: resolve worker on [2], then post [0], then DG([1,2])
        const trace = [];
        const blob = new Blob([${JSON.stringify(FP_WORKER_BODY)}], { type: "text/javascript" });
        const url = URL.createObjectURL(blob);
        const worker = new Worker(url);

        const workerReady = new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("worker ready timeout")), 5000);
            const o = (e) => {
                trace.push({ step: "init_listener", ...describeData(e.data) });
                if (e.data instanceof Array && e.data[0] === 2) {
                    clearTimeout(t);
                    worker.removeEventListener("message", o);
                    res(worker);
                }
            };
            worker.addEventListener("message", o);
        });

        const w = await workerReady;
        trace.push({ step: "worker_ready" });

        w.postMessage([0]);
        trace.push({ step: "posted_0" });

        const dgResult = await new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("DG timeout")), 5000);
            const z = (e) => {
                const d = e.data;
                trace.push({ step: "dg_listener", ...describeData(d) });
                if (d instanceof Array && (d[0] === 1 || d[0] === 2)) {
                    clearTimeout(t);
                    w.removeEventListener("message", z);
                    resolve(d);
                }
            };
            w.addEventListener("message", z);
        });

        w.terminate();
        URL.revokeObjectURL(url);
        return { ok: dgResult[0] === 1, dgType0: dgResult[0], trace };
    }

    let worker = { ok: false, error: "not_run" };
    let iframe = { ok: false, error: "not_run" };
    let dgRace = { ok: false, error: "not_run" };
    try { worker = await testWorkerProtocol(); } catch (e) { worker = { ok: false, error: String(e) }; }
    try { iframe = await testIframeCollector(); } catch (e) { iframe = { ok: false, error: String(e) }; }
    try { dgRace = await testDgRace(); } catch (e) { dgRace = { ok: false, error: String(e) }; }

    return {
        page: {
            url: location.href,
            title: document.title,
            readyState: document.readyState,
            hasBody: !!document.body,
            hasDocumentElement: !!document.documentElement,
        },
        worker,
        iframe,
        dgRace,
    };
}`;

const playgroundHookSource = `async () => {
    const events = { workers: [], iframes: [], errors: [] };
    const describeData = (d) => {
        if (d == null) return { kind: "null" };
        const isArr = d instanceof Array;
        return { isArray: isArr, type0: isArr ? d[0] : undefined, typeof: typeof d };
    };

    const OrigWorker = Worker;
    globalThis.Worker = function(url, opts) {
        const w = new OrigWorker(url, opts);
        const id = events.workers.length;
        events.workers.push({ id, url: String(url).slice(0, 120), messages: [] });
        w.addEventListener("message", (e) => {
            events.workers[id].messages.push({ dir: "in", t: Date.now(), ...describeData(e.data) });
        });
        const origPost = w.postMessage.bind(w);
        w.postMessage = function(data, transfer) {
            events.workers[id].messages.push({ dir: "out", t: Date.now(), ...describeData(data) });
            return origPost(data, transfer);
        };
        return w;
    };
    globalThis.Worker.prototype = OrigWorker.prototype;

    const origCreateElement = document.createElement.bind(document);
    document.createElement = function(tag, ...rest) {
        const el = origCreateElement(tag, ...rest);
        if (String(tag).toLowerCase() === "iframe") {
            const id = events.iframes.length;
            events.iframes.push({ id, snapshots: [] });
            const snap = (label) => {
                try {
                    events.iframes[id].snapshots.push({
                        label, t: Date.now(),
                        src: el.src,
                        cw: el.contentWindow == null ? "null" : "ok",
                        rs: el.contentWindow?.document?.readyState ?? null,
                        body: !!el.contentWindow?.document?.body,
                    });
                } catch (e) {
                    events.iframes[id].snapshots.push({ label, err: String(e) });
                }
            };
            el.addEventListener("load", () => snap("load"));
            const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src");
            if (desc?.set) {
                const origSet = desc.set;
                Object.defineProperty(el, "src", {
                    get: desc.get,
                    set(v) { snap("before_src_set"); origSet.call(el, v); snap("after_src_set"); },
                    configurable: true,
                });
            }
            const origAppend = el.appendChild.bind(el);
            el.appendChild = function(child) {
                snap("before_appendChild");
                const r = origAppend(child);
                snap("after_appendChild");
                return r;
            };
        }
        return el;
    };

    globalThis.__fpDualHook = events;
    return { hooked: true };
}`;

async function main() {
    await mkdir(OUT, { recursive: true });
    if (!existsSync(veloraBin)) throw new Error("Run zig build first");

    const { proc, endpoint, stderr } = await spawnVelora();
    const report = { isolated: null, playground: null };

    try {
        const browser = await Browser.connect(endpoint);
        const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

        // --- Phase 1: isolated on about:blank ---
        const page1 = await browser.newPage();
        await page1.session.send("Network.setUserAgentOverride", {
            userAgent: CHROME_UA,
            acceptLanguage: "en-US,en;q=0.9",
            platform: "MacIntel",
        }).catch(() => undefined);
        await page1.goto("about:blank", { waitUntil: "load", timeout: 30000 });
        report.isolated = await page1.evaluate(`(${dualProbeSource})()`).catch((e) => ({ error: String(e) }));
        await page1.close().catch(() => undefined);

        console.log("\n=== Isolated (about:blank) ===");
        console.log("Worker protocol:", report.isolated?.worker?.ok ? "PASS" : "FAIL", report.isolated?.worker?.error || "");
        if (report.isolated?.worker?.trace) {
            for (const s of report.isolated.worker.trace) console.log("  worker:", JSON.stringify(s));
        }
        console.log("Iframe collector:", report.isolated?.iframe?.ok ? "PASS" : "FAIL");
        if (report.isolated?.iframe?.final) console.log("  final:", JSON.stringify(report.isolated.iframe.final));
        console.log("DG race (SB pattern):", report.isolated?.dgRace?.ok ? "PASS" : "FAIL", report.isolated?.dgRace?.error || "");
        if (report.isolated?.dgRace?.trace) {
            for (const s of report.isolated.dgRace.trace) console.log("  dg:", JSON.stringify(s));
        }

        // --- Phase 2: playground with hooks ---
        const page2 = await browser.newPage();
        await page2.session.send("Network.setUserAgentOverride", {
            userAgent: CHROME_UA,
            acceptLanguage: "en-US,en;q=0.9",
            platform: "MacIntel",
        }).catch(() => undefined);

        const hookState = await page2.evaluate(playgroundHookSource);
        await page2.goto(PLAYGROUND, { waitUntil: "load", timeout: 90000 });

        for (let i = 0; i < 8; i++) {
            await delay(2000);
            const snap = await page2.evaluate(`(() => ({
                body: (document.body?.innerText || "").slice(0, 200),
                visitor: document.querySelector('[data-testid="visitor-id"]')?.textContent?.trim() || null,
            }))()`).catch((e) => ({ error: String(e) }));
            console.log(`[playground +${(i + 1) * 2}s] ${snap.body?.split("\\n").find(l => /timeout|visitor|error/i.test(l)) || snap.body?.slice(0, 60)}`);
            if (snap.visitor) break;
        }

        const events = await page2.evaluate(`(() => globalThis.__fpDualHook || null)()`).catch(() => null);

        report.playground = {
            hookState,
            events,
            body: await page2.evaluate(`document.body?.innerText?.slice(0, 300)`).catch(() => null),
        };

        // Better: use CDP to get console + run evaluate to dump worker/iframe from performance
        const liveProbe = await page2.evaluate(`(async () => {
            const posts = performance.getEntriesByType("resource")
                .filter(e => e.name.includes("fingerprint") || e.name.includes("DBqbMN7"))
                .map(e => ({ name: e.name, duration: e.duration }));
            return { posts, workerCount: typeof Worker, iframeCount: document.querySelectorAll("iframe").length };
        })()`).catch((e) => ({ error: String(e) }));
        report.playground.liveProbe = liveProbe;

        // Install retrospective: run dual probe on playground page too
        report.playground.onPageProbe = await page2.evaluate(`(${dualProbeSource})()`).catch((e) => ({ error: String(e) }));

        await page2.close().catch(() => undefined);
        await browser.close().catch(() => undefined);

        console.log("\n=== Playground on-page probe ===");
        console.log("Worker on playground page:", report.playground.onPageProbe?.worker?.ok ? "PASS" : "FAIL");
        console.log("Iframe on playground page:", report.playground.onPageProbe?.iframe?.ok ? "PASS" : "FAIL");
        console.log("DG race on playground page:", report.playground.onPageProbe?.dgRace?.ok ? "PASS" : "FAIL");

    } finally {
        proc.kill("SIGTERM");
        await delay(300);
        if (!proc.killed) proc.kill("SIGKILL");
    }

    report.verdict = buildVerdict(report);
    await writeFile(resolve(OUT, "dual-report.json"), JSON.stringify(report, null, 2));
    await writeFile(resolve(OUT, "velora.log"), Buffer.concat(stderr).toString());

    console.log("\n=== VERDICT ===");
    console.log(report.verdict.summary);
    for (const line of report.verdict.details) console.log(" ", line);
    console.log(`\nsaved: ${OUT}/dual-report.json`);
}

function buildVerdict(report) {
    const details = [];
    const iso = report.isolated || {};
    const workerOk = iso.worker?.ok === true;
    const iframeOk = iso.iframe?.ok === true;
    const dgOk = iso.dgRace?.ok === true;
    const onPage = report.playground?.onPageProbe || {};

    details.push(`isolated worker protocol: ${workerOk ? "OK" : "BROKEN"}`);
    details.push(`isolated iframe collector: ${iframeOk ? "OK" : "BROKEN"}`);
    details.push(`isolated DG race (SB): ${dgOk ? "OK" : "BROKEN"}`);
    if (onPage.worker) details.push(`playground-page worker: ${onPage.worker.ok ? "OK" : "BROKEN"}`);
    if (onPage.iframe) details.push(`playground-page iframe: ${onPage.iframe.ok ? "OK" : "BROKEN"}`);

    let root = "unknown";
    if (!workerOk || !dgOk) {
        root = "worker_message_protocol";
        if (iso.worker?.trace) {
            const last = iso.worker.trace.at(-1);
            details.push(`worker failed at: ${last?.stage || last?.error || "?"}`);
        }
        if (iso.dgRace?.trace) {
            for (const t of iso.dgRace.trace) {
                if (t.step === "dg_listener") details.push(`DG saw message: type0=${t.type0} isArray=${t.isArray}`);
            }
        }
    } else if (!iframeOk) {
        root = "iframe_collector";
        details.push(`iframe final: ${JSON.stringify(iso.iframe?.final)}`);
    } else if (onPage.worker && !onPage.worker.ok) {
        root = "playground_specific_worker";
    } else if (onPage.iframe && !onPage.iframe.ok) {
        root = "playground_specific_iframe";
    } else {
        root = "downstream_after_probes_ok";
        details.push("isolated probes pass — timeout likely in FP module execution or network POST");
    }

    return {
        rootCause: root,
        summary: `Root cause hypothesis: ${root}`,
        details,
    };
}

main().catch((err) => {
    console.error("FAILED:", err?.stack || err);
    process.exit(1);
});