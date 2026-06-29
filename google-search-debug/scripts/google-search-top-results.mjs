#!/usr/bin/env node
/**
 * Google search via warmed Velora session → top N organic results.
 *
 *   node google-search-debug/scripts/google-search-top-results.mjs --query coingloo.com
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
    REPO,
    buildSearchUrl,
    connectCdp,
    getFreePort,
    spawnVelora,
    killProc,
} from "../lib/cdp.mjs";
import { createProbeBudget, parseMaxSecArg } from "../../scripts/lib/cdp-probe-budget.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const PROFILE = "chrome-local-huys-macbook-pro";

function parseArgs(argv) {
    const out = {
        query: "coingloo.com",
        limit: 5,
        maxSec: parseMaxSecArg(argv),
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--query") out.query = argv[++i];
        else if (a === "--limit") out.limit = Number(argv[++i]);
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
    }
    return out;
}

const EXTRACT_JS = `
(() => {
  const out = [];
  const seen = new Set();
  const blocks = document.querySelectorAll("#search .g, #rso .g, div[data-sokoban-container] a h3");
  const roots = blocks.length
    ? [...document.querySelectorAll("#search a:has(h3), #rso a:has(h3)")]
    : [...document.querySelectorAll("a h3")].map((h) => h.closest("a"));

  for (const a of roots) {
    if (!a) continue;
    const h3 = a.querySelector("h3");
    const title = h3?.innerText?.trim();
    let href = a.href || "";
    if (!title || !href) continue;
    if (href.includes("google.com/search") || href.includes("/sorry")) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    const card = a.closest(".g, [data-sokoban-container], div");
    const snippet = card?.innerText?.split("\\n").slice(1, 4).join(" ").trim().slice(0, 300) || "";
    out.push({ title, url: href, snippet });
    if (out.length >= __LIMIT__) break;
  }
  return {
    pageTitle: document.title,
    resultCount: out.length,
    results: out,
    pathHint: {
      bodyLen: document.documentElement.innerHTML.length,
      hasKnitsail: document.documentElement.innerHTML.includes("knitsail"),
      hasSclm: /sclm=/.test(document.documentElement.innerHTML),
    },
  };
})()
`;

async function main() {
    const args = parseArgs(process.argv.slice(2));
    let proc = null;
    const budget = createProbeBudget(args.maxSec, ({ signal }) => killProc(proc, signal));
    const port = await getFreePort();
    const launch = await spawnVelora(PROFILE, port);
    proc = launch.proc;

    const url = buildSearchUrl(args.query, { hl: "en" });
    const conn = await connectCdp(launch.endpoint);
    const { client, sessionId } = conn;

    const docHops = [];
    client.ws.on("message", (raw) => {
        try {
            const msg = JSON.parse(String(raw));
            if (msg.sessionId && msg.sessionId !== sessionId) return;
            if (msg.method === "Network.responseReceived" && msg.params?.type === "Document") {
                docHops.push(msg.params.response?.url || "");
            }
        } catch {}
    });

    try {
        await client.send("Network.enable", {}, sessionId);
        await client.send("Page.enable", {}, sessionId);
        console.log(`[search] ${url}`);
        await client.send("Page.navigate", { url }, sessionId).catch(() => {});

        let extract = null;
        const expr = EXTRACT_JS.replace("__LIMIT__", String(args.limit));
        const t0 = Date.now();
        while (budget.remaining() > 500) {
            await delay(500);
            const res = await client.send("Runtime.evaluate", {
                expression: expr,
                returnByValue: true,
            }, sessionId).catch(() => null);
            const val = res?.result?.value;
            if (val?.results?.length >= args.limit) {
                extract = val;
                break;
            }
            if (val?.results?.length && Date.now() - t0 > 8000) {
                extract = val;
                break;
            }
            if (val?.pageTitle && !val.pageTitle.startsWith("http") && val.results?.length) {
                extract = val;
                break;
            }
        }

        if (!extract?.results?.length) {
            const snap = await client.send("Runtime.evaluate", {
                expression: expr,
                returnByValue: true,
            }, sessionId).catch(() => null);
            extract = snap?.result?.value || { results: [], pageTitle: null, pathHint: {} };
        }

        const report = {
            query: args.query,
            url,
            profile: PROFILE,
            docHops,
            pageTitle: extract.pageTitle,
            pathHint: extract.pathHint,
            results: extract.results,
        };

        const outDir = resolve(REPO, `google-search-debug/tmp/top-results-${Date.now()}`);
        await mkdir(outDir, { recursive: true });
        await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));

        console.log(`\n=== Top ${args.limit} results: ${args.query} ===`);
        console.log(`title: ${extract.pageTitle}`);
        console.log(`path: ${extract.pathHint?.hasSclm ? "long-bootstrap" : extract.pathHint?.bodyLen > 120000 ? "short-serp" : "unknown"}`);
        for (const [i, r] of extract.results.entries()) {
            console.log(`\n${i + 1}. ${r.title}`);
            console.log(`   ${r.url}`);
            if (r.snippet) console.log(`   ${r.snippet.slice(0, 160)}...`);
        }
        if (!extract.results.length) {
            console.log("\n(no organic results parsed — cookie may be expired or blocked)");
        }
        console.log(`\nreport: ${outDir}/report.json`);
        budget.clear();
    } finally {
        budget.clear();
        client.close();
        killProc(proc);
    }
}

main().catch((e) => { console.error(e); process.exit(2); });