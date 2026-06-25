#!/usr/bin/env node
/**
 * Knitsail reverse-engineering pipeline (Direction A).
 *
 * 1. dump program material (sp, sgs events) from Chrome
 * 2. decrypt sp → bytecode (Xj per SerpBase)
 * 3. static disasm (slot histogram)
 * 4. runtime trace (host API access map)
 * 5. merge → signal formula checklist
 *
 * Usage:
 *   node code-check/sites/google/knitsail/analyze.mjs
 *   node code-check/sites/google/knitsail/analyze.mjs --skip-dump --html ./page.html
 *   node code-check/sites/google/knitsail/analyze.mjs --query test --compare-trace
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseProgram, parseProgramFromDump } from "./bytecode.mjs";
import { disassemble, inferSignals } from "./disasm.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const OUT = resolve(repoRoot, "code-check/tmp/knitsail-analysis");
const DUMP_JSON = resolve(repoRoot, "code-check/tmp/knitsail-dump/dump.json");
const TRACE_JSON = resolve(repoRoot, "code-check/tmp/knitsail-trace/trace.json");

function parseArgs(argv) {
    const out = {
        query: `knitsail-${Date.now()}`,
        skipDump: false,
        skipTrace: false,
        compareTrace: true,
        html: null,
        spawnChrome: false,
        endpoint: undefined,
        cooldown: 30_000,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        const next = () => { i += 1; return argv[i]; };
        switch (a) {
            case "--query": out.query = next(); break;
            case "--skip-dump": out.skipDump = true; break;
            case "--skip-trace": out.skipTrace = true; break;
            case "--no-compare-trace": out.compareTrace = false; break;
            case "--html": out.html = resolve(next()); out.skipDump = true; break;
            case "--spawn-chrome": out.spawnChrome = true; break;
            case "--endpoint": out.endpoint = next(); break;
            case "--cooldown": out.cooldown = Number(next()); break;
            case "--help":
                console.log(`Usage: node analyze.mjs [--query Q] [--skip-dump] [--skip-trace] [--html path] [--no-compare-trace]`);
                process.exit(0);
            default:
                throw new Error(`Unknown arg: ${a}`);
        }
    }
    return out;
}

function runNode(script, args = []) {
    return new Promise((res, rej) => {
        const proc = spawn(process.execPath, [script, ...args], { stdio: "inherit" });
        proc.on("exit", (code) => (code === 0 ? res() : rej(new Error(`${script} exit ${code}`))));
    });
}

function loadJson(path) {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
}

function buildFormulaReport({ dump, programs, disasms, trace }) {
    const spLive = dump?.dump?.vars?.p || dump?.vars?.p || dump?.dump?.vars?.sp || dump?.vars?.sp || "";
    const sgsEvents = dump?.dump?.sgsEvents || [];
    const traceResults = trace?.results || [];

    const checklist = [
        { signal: "performance.now", source: "SerpBase + trace", status: "pending", note: "Compare now jitter Chrome vs Velora" },
        { signal: "performance.timing", source: "SerpBase + trace", status: "pending", note: "navigationStart/responseStart in bootstrap" },
        { signal: "document.readyState", source: "SerpBase + trace", status: "pending", note: "" },
        { signal: "window.trustedTypes", source: "SerpBase + bootstrap", status: dump?.dump?.ttEval === true ? "chrome-ok" : "check", note: `ttEval=${dump?.dump?.ttEval}` },
        { signal: "navigator.*", source: "SerpBase + trace", status: "pending", note: "UA/platform/languages/hw/deviceMemory" },
        { signal: "screen.*", source: "SerpBase + trace", status: "pending", note: "width/height vs window" },
        { signal: "location.href", source: "SerpBase + trace", status: "pending", note: "" },
        { signal: "Math.random", source: "SerpBase", status: "known-random", note: "Output non-deterministic; formula uses random padding" },
    ];

    if (trace?.diff) {
        for (const item of checklist) {
            if (item.signal === "performance.now" && trace.diff.jitterA && trace.diff.jitterB) {
                const ja = trace.diff.jitterA;
                const jb = trace.diff.jitterB;
                const ratio = jb.variance / Math.max(ja.variance, 1e-9);
                item.status = ratio < 0.25 || ratio > 4 ? "DELTA" : "similar";
                item.note = `var chrome=${ja.variance.toFixed(6)} velora=${jb.variance.toFixed(6)}`;
            }
        }
        const missing = trace.diff.onlyB.length ? trace.diff.onlyB : [];
        if (missing.length) {
            const nav = checklist.find((c) => c.signal.startsWith("navigator"));
            if (nav) { nav.status = "DELTA"; nav.note = `velora-only paths: ${missing.slice(0, 5).join(", ")}`; }
        }
    }

    return {
        spCaptured: spLive.length > 20,
        spLen: spLive.length,
        sgsFlow: sgsEvents.map((e) => e.phase).join(" → ") || "(no sgs events — sp may be empty at hop1)",
        programsDecoded: programs.filter((p) => p.parsed?.bytecode).length,
        disasmCoverage: disasms.map((d) => ({ field: d.field, coveragePct: d.disasm?.coveragePct, topSlots: d.disasm?.topSlots?.slice(0, 8) })),
        inferredSignals: disasms[0] ? inferSignals(disasms[0].disasm) : null,
        checklist,
        traceSummary: traceResults.map((r) => ({ label: r.label, ...r.summary, outcome: r.sorry ? "sorry" : r.serp ? "SERP" : "other" })),
        nextSteps: [
            "Re-run dump until spLen>100 and sgsFlow includes call→resolve",
            "Map disasm call_host slots to trace topPaths for stable opcode→API table",
            "Fix Velora signals marked DELTA in checklist",
        ],
    };
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    mkdirSync(OUT, { recursive: true });

    let dump;
    if (opts.html) {
        console.log("=== [1/3] Load static HTML dump ===");
        await runNode(resolve(__dirname, "dump.mjs"), ["--html", opts.html, "--query", opts.query]);
        dump = loadJson(DUMP_JSON);
    } else if (!opts.skipDump) {
        const dumpArgs = ["--query", opts.query];
        if (opts.spawnChrome) dumpArgs.push("--spawn-chrome");
        if (opts.endpoint) dumpArgs.push("--endpoint", opts.endpoint);
        console.log("=== [1/3] Dump Knitsail program material (real Chrome) ===");
        await runNode(resolve(__dirname, "dump.mjs"), dumpArgs);
        dump = loadJson(DUMP_JSON);
    } else {
        dump = loadJson(DUMP_JSON);
    }
    if (!dump) throw new Error(`No dump at ${DUMP_JSON}`);

    console.log("\n=== [2/3] Decrypt + disassemble sp ===");
    const globals = dump.dump?.vars || dump.vars || {};
    const programs = parseProgramFromDump({ globals, sp: globals.sp, spLive: globals.sp });
    const disasms = [];

    for (const p of programs) {
        if (!p.parsed?.bytecode) {
            console.log(`  ${p.field}: ${p.parsed?.error || "no bytecode"} (len=${String(p.value).length})`);
            continue;
        }
        const disasm = disassemble(p.parsed.bytecode, p.parsed.key, { verbose: false });
        disasms.push({ field: p.field, key: p.parsed.key, bytecodeLen: p.parsed.bytecodeLen, disasm });
        console.log(`  ${p.field}: bytecode=${p.parsed.bytecodeLen}B coverage=${disasm.coveragePct}% topSlots=${disasm.topSlots.slice(0, 5).map((s) => s.slot + "×" + s.count).join(" ")}`);
    }

    if (!opts.skipTrace) {
        console.log("\n=== [3/3] Runtime trace (host API reads) ===");
        const traceArgs = ["--query", opts.query, "--cooldown", String(opts.cooldown)];
        if (opts.compareTrace) traceArgs.push("--compare");
        if (opts.spawnChrome) traceArgs.push("--spawn-chrome");
        if (opts.endpoint) traceArgs.push("--endpoint", opts.endpoint);
        await runNode(resolve(__dirname, "trace.mjs"), traceArgs);
    }

    const trace = loadJson(TRACE_JSON);
    const formula = buildFormulaReport({ dump, programs, disasms, trace });

    const report = {
        query: opts.query,
        dumpMeta: {
            source: dump.source,
            hops: dump.hops,
            vars: globals,
            sgsEvents: dump.dump?.sgsEvents,
        },
        programs: programs.map((p) => ({
            field: p.field,
            len: p.value?.length,
            parsed: p.parsed?.bytecode
                ? { key: p.parsed.key, bytecodeLen: p.parsed.bytecodeLen, hexPreview: p.parsed.bytecodeHexPreview }
                : { error: p.parsed?.error, prefix: p.parsed?.prefix },
        })),
        disasms: disasms.map((d) => ({ field: d.field, ...d.disasm, ops: undefined })),
        trace,
        formula,
    };

    writeFileSync(resolve(OUT, "report.json"), JSON.stringify(report, null, 2));

    console.log("\n=== Formula checklist (Direction A) ===");
    for (const c of formula.checklist) {
        console.log(`  [${c.status.padEnd(10)}] ${c.signal} — ${c.note}`);
    }
    console.log(`\nsp captured: ${formula.spCaptured} (len=${formula.spLen})`);
    console.log(`sgs flow: ${formula.sgsFlow}`);
    console.log("\nnext:");
    for (const s of formula.nextSteps) console.log(`  • ${s}`);
    console.log(`\nsaved: ${OUT}/report.json`);
}

main().catch((e) => {
    console.error(e);
    process.exit(2);
});