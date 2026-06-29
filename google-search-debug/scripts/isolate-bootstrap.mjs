#!/usr/bin/env node
/**
 * Isolate Google Search inline scripts — find which script fails and why.
 *
 *   node google-search-debug/scripts/isolate-bootstrap.mjs
 *   node google-search-debug/scripts/isolate-bootstrap.mjs --html path/to/response.html
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
    REPO,
    buildSearchUrl,
    connectCdp,
    getFreePort,
    spawnVelora,
    killProc,
} from "../lib/cdp.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = {
        profile: "chrome-local-huys-macbook-pro",
        query: "test",
        html: null,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--profile") out.profile = argv[++i];
        else if (a === "--query") out.query = argv[++i];
        else if (a === "--html") out.html = resolve(argv[++i]);
    }
    return out;
}

function extractScripts(html) {
    const scripts = [];
    const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
        const attrs = m[1] || "";
        const body = (m[2] || "").trim();
        if (/src\s*=/i.test(attrs)) {
            const src = attrs.match(/src=["']([^"']+)["']/i)?.[1] || "";
            scripts.push({ kind: "external", src, len: 0, body: "" });
        } else if (body.length > 0) {
            scripts.push({ kind: "inline", src: null, len: body.length, body });
        }
    }
    return scripts;
}

async function evalWithCatch(client, sessionId, code, label) {
    const wrapped = `(() => {
        const errors = [];
        const orig = window.onerror;
        window.onerror = (msg, url, line, col, err) => {
            errors.push({ msg: String(msg), url, line, col, stack: err?.stack?.slice(0, 800) });
            return false;
        };
        let thrown = null;
        try {
            ${code}
        } catch (e) {
            thrown = { msg: String(e?.message || e), stack: e?.stack?.slice(0, 800) };
        }
        window.onerror = orig;
        return {
            label: ${JSON.stringify(label)},
            thrown,
            onerrors: errors,
            knitsail: typeof globalThis.knitsail,
            knitsailA: typeof globalThis.knitsail?.a,
            googleSn: window.google?.sn ?? null,
        };
    })()`;
    const res = await client.send("Runtime.evaluate", {
        expression: wrapped,
        returnByValue: true,
        awaitPromise: true,
        timeout: 120000,
    }, sessionId);
    if (res.exceptionDetails) {
        return {
            label,
            evalError: res.exceptionDetails.text || "evaluate_failed",
            line: res.exceptionDetails.lineNumber,
        };
    }
    return res.result?.value || { label, empty: true };
}

async function probeEvalHarness(client, sessionId) {
    const expr = `(() => {
        const T = globalThis;
        const W = (v,V,B,D,y,J,C,H,k,F) => {
            k=v; while(k!=40) if(k==25){
                a:{ if(H=(C=T.trustedTypes,D),!C||!C.createPolicy){F=H;break a}
                try{H=C.createPolicy(y,{createHTML:(x)=>x,createScript:(x)=>x,createScriptURL:(x)=>x})}
                catch(O){if(T.console)T.console[J](O.message)} F=H} k=21
            } else if(k==38)k=B+3>>4?34:7; else if(k==7)F=D,k=34;
            else if(k==34)k=(B^V)>>4?21:25; else if(k==21)return F; else if(k==v)k=38;
        };
        const probe = W(63,36,32,null,"ks","error");
        const ev = T.eval;
        const factory = probe && ev(probe.createScript("1"))===1
            ? (B) => probe.createScript(B)
            : (B) => ""+B;
        const rnd = Array(Math.random()*100|0).join("\\n");
        let eval1 = null, eval1err = null;
        try { eval1 = ev(factory("1+1")); } catch(e) { eval1err = String(e); }
        let indirect = null, indirectErr = null;
        try { indirect = (0,ev)(factory("2+2")); } catch(e) { indirectErr = String(e); }
        return { hasPolicy: !!probe, eval1, eval1err, indirect, indirectErr, factoryType: typeof factory };
    })()`;
    const res = await client.send("Runtime.evaluate", { expression: expr, returnByValue: true }, sessionId);
    return res.result?.value || { error: res.exceptionDetails?.text };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    let html;
    if (args.html) {
        html = await readFile(args.html, "utf8");
    } else {
        const glob = await import("node:fs/promises").then((m) =>
            m.readdir(resolve(REPO, "google-search-debug/tmp")).catch(() => []));
        const traces = glob.filter((d) => d.startsWith("trace-velora-")).sort().reverse();
        const latest = traces[0];
        if (!latest) throw new Error("No trace HTML — run google:trace first or pass --html");
        html = await readFile(resolve(REPO, `google-search-debug/tmp/${latest}/response.html`), "utf8");
        console.log(`Using HTML: tmp/${latest}/response.html`);
    }

    const scripts = extractScripts(html);
    console.log(`Extracted ${scripts.length} script tags\n`);

    const port = await getFreePort();
    const launch = await spawnVelora(args.profile, port);
    const { client, sessionId } = await connectCdp(launch.endpoint);

    const report = {
        at: new Date().toISOString(),
        scriptCount: scripts.length,
        harness: null,
        scripts: [],
        replay: [],
    };

    try {
        await client.send("Runtime.enable", {}, sessionId);
        await client.send("Page.navigate", { url: "about:blank" }, sessionId);
        await delay(500);

        report.harness = await probeEvalHarness(client, sessionId);
        console.log("Eval harness (Velora):", JSON.stringify(report.harness, null, 2));

        // Seed google + globals like inline HTML does before script 3
        await evalWithCatch(client, sessionId,
            `window.google = window.google || {}; window.google.c = window.google.c || {cap:0};`,
            "seed-google");

        for (let i = 0; i < scripts.length; i += 1) {
            const s = scripts[i];
            if (s.kind === "external") {
                report.scripts.push({ i, kind: "external", src: s.src, skipped: true });
                continue;
            }
            console.log(`\n--- Script ${i} (${s.len} bytes) ---`);
            if (s.len > 500000) {
                console.log("  too large for single eval — testing prefix probes");
                const probes = [
                    { name: "closure-header", code: s.body.slice(0, 1200) },
                    { name: "eval-probe-only", code: s.body.match(/\(0,eval\)\(function[\s\S]{0,800}/)?.[0] || "" },
                ];
                for (const p of probes) {
                    if (!p.code) continue;
                    const r = await evalWithCatch(client, sessionId, p.code, `script${i}-${p.name}`);
                    console.log(`  ${p.name}:`, JSON.stringify(r, null, 2));
                    report.replay.push(r);
                }
                report.scripts.push({ i, len: s.len, partial: true });
                continue;
            }
            const r = await evalWithCatch(client, sessionId, s.body, `script${i}`);
            console.log(JSON.stringify(r, null, 2));
            report.scripts.push({ i, len: s.len, result: r });
            report.replay.push(r);
            if (r.thrown || r.onerrors?.length || r.evalError) {
                console.log(`  ^^^ FAIL at script ${i}`);
            }
        }

        const outDir = resolve(REPO, "google-search-debug/tmp");
        await mkdir(outDir, { recursive: true });
        const outPath = resolve(outDir, "isolate-bootstrap-report.json");
        await writeFile(outPath, JSON.stringify(report, null, 2));
        console.log(`\nSaved: ${outPath}`);
    } finally {
        client.close();
        killProc(launch.proc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });