#!/usr/bin/env node
// Compare TrustedTypes / Worker / Proxy probes: Velora vs Chrome.
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { Browser } from "../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const OUT = resolve(repoRoot, "code-check/tmp/tt-worker-proxy");

const PROBE = `(async () => {
    const r = (fn, fb = null) => { try { return fn(); } catch (e) { return { error: String(e), stack: (e.stack||"").split("\\n").slice(0,3) }; } };
    const out = {};

    // TrustedTypes — Google-style bootstrap
    out.tt = r(() => {
        const w = (s) => s;
        const H = trustedTypes.createPolicy("goog#html", {
            createHTML: w,
            createScript: w,
            createScriptURL: w,
        });
        const scriptUrl = H.createScriptURL("data:application/javascript,self.postMessage(1)");
        const script = H.createScript("self.postMessage(2)");
        const html = H.createHTML("<b>x</b>");
        return {
            hasPolicy: !!H,
            policyName: H.name,
            scriptUrlType: typeof scriptUrl,
            scriptUrlVal: String(scriptUrl).slice(0, 80),
            scriptVal: String(script).slice(0, 40),
            htmlVal: String(html).slice(0, 40),
            isScriptURL: trustedTypes.isScriptURL(scriptUrl),
            isScript: trustedTypes.isScript(script),
            isHTML: trustedTypes.isHTML(html),
            ttKeys: Object.keys(trustedTypes).sort(),
        };
    });

    // Worker from blob (Google pattern)
    out.workerBlob = await r(async () => {
        const blob = new Blob(["self.onmessage=e=>self.postMessage(e.data+1)"], { type: "application/javascript" });
        const url = URL.createObjectURL(blob);
        const w = new Worker(url);
        const msg = await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("worker timeout")), 3000);
            w.onmessage = (e) => { clearTimeout(t); res(e.data); };
            w.onerror = (e) => { clearTimeout(t); rej(e.message || "worker error"); };
            w.postMessage(41);
        });
        w.terminate();
        URL.revokeObjectURL(url);
        return { msg, workerProto: Object.getPrototypeOf(w)?.constructor?.name };
    });

    // Worker from TrustedScriptURL blob path
    out.workerTT = await r(async () => {
        const w = (s) => s;
        const H = trustedTypes.createPolicy("t", { createHTML: w, createScript: w, createScriptURL: w });
        const code = "self.onmessage=e=>self.postMessage('tt:'+e.data)";
        const blob = new Blob([code], { type: "application/javascript" });
        const blobUrl = URL.createObjectURL(blob);
        const trustedUrl = H.createScriptURL(blobUrl);
        const wkr = new Worker(String(trustedUrl));
        const msg = await new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error("tt worker timeout")), 3000);
            wkr.onmessage = (e) => { clearTimeout(t); res(e.data); };
            wkr.onerror = (e) => { clearTimeout(t); rej(String(e.message || e)); };
            wkr.postMessage("ping");
        });
        wkr.terminate();
        URL.revokeObjectURL(blobUrl);
        return { msg };
    });

    // Proxy traps (Google obfuscator style)
    out.proxy = r(() => {
        const target = { a: 1, b: 2 };
        const log = [];
        const p = new Proxy(target, {
            get(t, k, r) { log.push("get:" + String(k)); return Reflect.get(t, k, r); },
            set(t, k, v, r) { log.push("set:" + String(k)); return Reflect.set(t, k, v, r); },
            has(t, k) { log.push("has:" + String(k)); return Reflect.has(t, k); },
            ownKeys(t) { log.push("ownKeys"); return Reflect.ownKeys(t); },
            getOwnPropertyDescriptor(t, k) { log.push("desc:" + String(k)); return Reflect.getOwnPropertyDescriptor(t, k); },
        });
        const x = p.a;
        p.c = 3;
        "a" in p;
        Object.keys(p);
        return { x, log, proxyToString: Function.prototype.toString.call(Proxy).slice(0, 40) };
    });

    // Function native check
    out.native = r(() => ({
        proxyNative: /\\[native code\\]/.test(Function.prototype.toString.call(Proxy)),
        reflectGet: typeof Reflect.get === "function",
        evalNative: /\\[native code\\]/.test(Function.prototype.toString.call(eval)),
        chromeLoadTimes: window.chrome ? /\\[native code\\]/.test(Function.prototype.toString.call(chrome.loadTimes)) : null,
    }));

    // WebAssembly
    out.wasm = r(() => ({
        hasWasm: typeof WebAssembly !== "undefined",
        compile: typeof WebAssembly.compile === "function",
        Module: typeof WebAssembly.Module === "function",
    }));

    return out;
})()`;

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

async function veloraProbe() {
    const port = await getFreePort();
    const proc = spawn(veloraBin, [
        "serve", "--host", "127.0.0.1", "--port", String(port),
        "--browser-profile", "chrome-macos-sonoma", "--log-level", "warn",
    ], { cwd: repoRoot, stdio: "ignore" });
    const endpoint = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 40; i++) {
        try { if ((await fetch(`${endpoint}/json/version`)).ok) break; } catch {}
        await delay(100);
    }
    const browser = await Browser.connect(endpoint);
    try {
        const page = await browser.newPage();
        await page.goto("about:blank");
        await delay(300);
        return await page.evaluate(PROBE);
    } finally {
        await browser.close().catch(() => {});
        proc.kill("SIGTERM");
    }
}

async function chromeProbe() {
    const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--incognito"] });
    try {
        const page = await browser.newPage();
        await page.goto("about:blank");
        return await page.evaluate(PROBE);
    } finally {
        await browser.close();
    }
}

function diff(a, b, path = "") {
    const out = [];
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
        const p = path ? `${path}.${k}` : k;
        const va = a?.[k];
        const vb = b?.[k];
        if (va && vb && typeof va === "object" && typeof vb === "object" && !Array.isArray(va)) {
            out.push(...diff(va, vb, p));
        } else if (JSON.stringify(va) !== JSON.stringify(vb)) {
            out.push({ key: p, velora: va, chrome: vb });
        }
    }
    return out;
}

async function main() {
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    mkdirSync(OUT, { recursive: true });
    const velora = await veloraProbe();
    const chrome = await chromeProbe();
    const diffs = diff(velora, chrome);
    writeFileSync(resolve(OUT, "compare.json"), JSON.stringify({ velora, chrome, diffs }, null, 2));
    console.log(`diffs: ${diffs.length}`);
    for (const d of diffs) {
        console.log(`\n${d.key}:`);
        console.log(`  velora: ${JSON.stringify(d.velora)?.slice(0, 120)}`);
        console.log(`  chrome: ${JSON.stringify(d.chrome)?.slice(0, 120)}`);
    }
    console.log(`\nsaved: ${OUT}/compare.json`);
}

main().catch((e) => { console.error(e); process.exit(2); });