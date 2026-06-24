#!/usr/bin/env node
// Probe Google SGS shell: trustedTypes+eval, window.knitsail, la()/ia() path.
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Browser } from "../../../sdk/dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");
const veloraBin = resolve(repoRoot, "zig-out/bin/velora");
const OUT = resolve(repoRoot, "code-check/tmp/google-sgs-probe");
const SEARCH = "https://www.google.com/search?q=sgssprobe&hl=en";

const EARLY_PROBE = `(() => {
    try {
        const root = window.top;
        const out = root.__sgsProbe || (root.__sgsProbe = { snaps: [], exceptions: [] });
        const snap = (tag) => {
            try {
                let ttProbe = { ok: false, error: "skip" };
                try {
                    const tt = window.trustedTypes;
                    if (tt && tt.createPolicy) {
                        const id = (s) => s;
                        const pol = tt.createPolicy("ks", { createHTML: id, createScript: id, createScriptURL: id });
                        const ev = eval(pol.createScript("1"));
                        ttProbe = { ok: true, evalResult: ev, evalIsOne: ev === 1 };
                    }
                } catch (e) {
                    ttProbe = { ok: false, error: String(e) };
                }
                out.snaps.push({
                    t: performance.now(),
                    tag,
                    href: String(location.href).slice(0, 160),
                    knitsail: typeof window.knitsail,
                    knitsailA: window.knitsail ? typeof window.knitsail.a : "n/a",
                    knitsailKeys: window.knitsail ? Object.keys(window.knitsail).sort() : [],
                    sgs: typeof window.sgs,
                    enablejs: document.documentElement.innerHTML.indexOf("enablejs") >= 0,
                    serp: document.documentElement.innerHTML.indexOf("SearchResultsPage") >= 0,
                    htmlLen: document.documentElement.outerHTML.length,
                    ttProbe,
                });
            } catch (e) {
                out.exceptions.push({ tag, error: String(e) });
            }
        };
        try {
            let _knitsail = window.knitsail;
            Object.defineProperty(window, "knitsail", {
                get() { return _knitsail; },
                set(v) {
                    _knitsail = v;
                    snap("knitsail-set");
                },
                configurable: true,
                enumerable: true,
            });
        } catch (e) {
            out.exceptions.push({ tag: "knitsail-trap", error: String(e) });
        }
        snap("doc-init");
        document.addEventListener("DOMContentLoaded", () => snap("dcl"), { once: true });
    } catch (e) {
        window.top.__sgsProbe = { snaps: [], exceptions: [{ tag: "boot", error: String(e) }] };
    }
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

async function main() {
    if (!existsSync(veloraBin)) throw new Error("zig build first");
    mkdirSync(OUT, { recursive: true });

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

    const exceptions = [];
    const docs = [];

    try {
        const b = await Browser.connect(endpoint);
        const page = await b.newPage();
        const session = page.session;

        await session.send("Page.addScriptToEvaluateOnNewDocument", { source: EARLY_PROBE });
        await session.send("Runtime.enable");
        session.on("Runtime.exceptionThrown", (p) => {
            const d = p.exceptionDetails || {};
            exceptions.push({
                t: Date.now(),
                text: d.text,
                url: (d.url || "").slice(0, 160),
                line: d.lineNumber,
                col: d.columnNumber,
            });
        });

        session.on("Network.requestWillBeSent", (p) => {
            if (p.type !== "Document") return;
            const url = p.request?.url || "";
            if (!url.includes("google.com")) return;
            docs.push({ t: Date.now(), url: url.slice(0, 200) });
        });

        let probe = { snaps: [], exceptions: [] };
        const readProbe = async () => {
            try {
                return await page.evaluate(`(() => {
                    const s = (window.top && window.top.__sgsProbe) || window.__sgsProbe || {};
                    return { snaps: s.snaps || [], exceptions: s.exceptions || [] };
                })()`);
            } catch {
                return probe;
            }
        };

        await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 90_000 });
        await delay(2000);
        probe = await readProbe();

        let evalPing = null;
        try {
            evalPing = await page.evaluate(`(() => ({
                hasProbe: !!(window.top && window.top.__sgsProbe),
                url: location.href.slice(0, 120),
                knitsail: typeof window.knitsail,
            }))()`);
        } catch (e) {
            evalPing = { error: String(e) };
        }

        const report = { search: SEARCH, docs, exceptions, probe, evalPing };
        writeFileSync(resolve(OUT, "probe.json"), JSON.stringify(report, null, 2));

        console.log("=== doc hops ===");
        for (const d of docs) console.log(" ", d.url.slice(0, 90));

        console.log("\n=== JS exceptions (" + exceptions.length + ") ===");
        for (const e of exceptions.slice(0, 8)) {
            console.log(`  ${e.url?.slice(-60) || "?"}:${e.line}:${e.col} ${e.text?.slice(0, 120)}`);
        }

        console.log("\n=== probe snaps ===");
        for (const s of probe.snaps.slice(0, 12)) {
            console.log(
                `[${s.tag}] knitsail=${s.knitsail} a=${s.knitsailA} sgs=${s.sgs} sp=${s.sp} ussv=${s.ussv} enablejs=${s.enablejs} serp=${s.serp} tt=${s.ttProbe?.ok}${s.ttProbe?.evalIsOne ? " eval=1" : ""}`,
            );
            if (s.knitsailKeys?.length) console.log("  keys:", s.knitsailKeys.join(","));
            if (s.ttProbe?.error) console.log("  tt err:", s.ttProbe.error);
        }

        console.log("\n=== eval ping ===", JSON.stringify(evalPing));

        console.log(`\nsaved: ${OUT}/probe.json`);
        await b.close();
    } finally {
        proc.kill("SIGTERM");
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});