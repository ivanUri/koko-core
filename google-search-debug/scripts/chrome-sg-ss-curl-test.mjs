#!/usr/bin/env node
/**
 * Capture sg_ss (or sei) URL from real Chrome guest search, then curl_chrome146 immediately.
 *
 *   node google-search-debug/scripts/chrome-sg-ss-curl-test.mjs --query test
 */
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { captureGoogleSearch } from "../lib/capture-search.mjs";
import {
    REPO,
    buildSearchUrl,
    resolveGoogleChromeSession,
    killProc,
} from "../lib/cdp.mjs";

const CURL = resolve(REPO, "vendor/curl-impersonate/curl_chrome146");
const OUT = resolve(REPO, "google-search-debug/tmp");

function parseArgs(argv) {
    const out = { query: "test", maxSec: 25, hl: "en" };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--query") out.query = argv[++i];
        else if (a === "--max-sec") out.maxSec = Number(argv[++i]);
        else if (a === "--hl") out.hl = argv[++i];
    }
    return out;
}

function pickSgSsUrl(capture) {
    const fromTitle = capture.dom?.title?.startsWith("http") && capture.dom.title.includes("sg_ss=")
        ? capture.dom.title
        : null;
    const fromHref = capture.finalUrl?.includes("sg_ss=") ? capture.finalUrl : null;
    const fromNetwork = (capture.network || [])
        .filter((r) => r.type === "Document" && r.url?.includes("sg_ss="))
        .map((r) => r.url)
        .pop();
    return fromTitle || fromHref || fromNetwork || null;
}

function pickSeiUrl(capture) {
    const candidates = [
        capture.finalUrl,
        capture.dom?.title?.startsWith("http") ? capture.dom.title : null,
        ...(capture.network || [])
            .filter((r) => r.type === "Document" && r.url?.includes("sei=") && !r.url.includes("sg_ss="))
            .map((r) => r.url),
    ].filter(Boolean);
    return candidates.find((u) => u.includes("sei=") && !u.includes("sg_ss=")) || null;
}

function curlProbe(label, url) {
    const head = execFileSync(CURL, [
        "-sI", url, "-o", "/dev/null", "-w", "%{http_code} %{http_version}",
    ], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }).trim();

    const getHeaders = execFileSync(CURL, ["-s", "-D", "-", "-o", "/dev/null", url], {
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
    });
    const statusLine = getHeaders.split(/\r?\n/).find((l) => /^HTTP/i.test(l)) || "";
    const location = getHeaders.split(/\r?\n/).find((l) => /^location:/i.test(l)) || "";

    let followStatus = null;
    let followUrl = null;
    try {
        const follow = execFileSync(CURL, [
            "-sL", url, "-o", "/dev/null", "-w", "%{http_code} %{url_effective}",
        ], { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: 15_000 }).trim();
        const [code, ...rest] = follow.split(" ");
        followStatus = code;
        followUrl = rest.join(" ");
    } catch (e) {
        followStatus = `err:${e.message?.slice(0, 80)}`;
    }

    return {
        label,
        urlLen: url.length,
        head,
        get: `${statusLine.trim()} ${location.trim()}`.trim(),
        followStatus,
        followUrl: followUrl?.slice(0, 200) || null,
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const startUrl = buildSearchUrl(args.query, { hl: args.hl });
    let chromeProc = null;

    console.log("=== Chrome guest → curl sg_ss test ===");
    console.log(`query: ${args.query}`);
    console.log(`url:   ${startUrl}\n`);

    try {
        const chrome = await resolveGoogleChromeSession({
            profileDir: `/tmp/velora-chrome-sgss-${Date.now()}`,
        });
        chromeProc = chrome.proc;
        console.log(`[chrome] ${chrome.endpoint} ${chrome.version?.Browser || ""}`);

        const capture = await captureGoogleSearch({
            endpoint: chrome.endpoint,
            url: startUrl,
            label: "chrome-guest",
            maxSec: args.maxSec,
            injectFingerprint: false,
        });

        const sgUrl = pickSgSsUrl(capture);
        const seiUrl = pickSeiUrl(capture);
        const report = {
            query: args.query,
            chrome: {
                finalUrl: capture.finalUrl,
                title: capture.dom?.title,
                isSorry: capture.serp?.isSorry,
                hasSearchResults: capture.dom?.hasSearchResults,
                resultStats: capture.dom?.resultStats,
                documentHops: (capture.network || [])
                    .filter((r) => r.type === "Document")
                    .map((r) => ({
                        status: r.status,
                        protocol: r.protocol,
                        hasSgSs: r.url?.includes("sg_ss="),
                        hasSei: r.url?.includes("sei="),
                        isSorry: r.url?.includes("/sorry"),
                        url: (r.url || "").slice(0, 140),
                    })),
            },
            sgSsUrl: sgUrl ? `${sgUrl.slice(0, 120)}...` : null,
            seiUrl: seiUrl ? `${seiUrl.slice(0, 120)}...` : null,
            curl: {},
        };

        console.log("\n--- Chrome capture ---");
        console.log(`final: ${capture.finalUrl?.slice(0, 120)}...`);
        console.log(`title: ${capture.dom?.title?.slice(0, 80)}`);
        console.log(`SERP:  ${capture.dom?.hasSearchResults ? "yes" : "no"}  sorry: ${capture.serp?.isSorry}`);
        console.log(`sg_ss: ${sgUrl ? `yes (${sgUrl.length} chars)` : "no"}`);
        console.log(`sei:   ${seiUrl ? `yes (${seiUrl.length} chars)` : "no"}`);

        console.log("\nDocument hops:");
        for (const h of report.chrome.documentHops) {
            const flags = [
                h.hasSgSs ? "sg_ss" : null,
                h.hasSei ? "sei" : null,
                h.isSorry ? "sorry" : null,
            ].filter(Boolean).join(",");
            console.log(`  ${h.status} ${h.protocol} ${flags} ${h.url}`);
        }

        console.log("\n--- curl_chrome146 (immediate) ---");
        if (sgUrl) {
            report.curl.sg_ss = curlProbe("sg_ss", sgUrl);
            console.log("sg_ss HEAD:", report.curl.sg_ss.head);
            console.log("sg_ss GET: ", report.curl.sg_ss.get.slice(0, 100));
            console.log("sg_ss -L:  ", report.curl.sg_ss.followStatus, report.curl.sg_ss.followUrl || "");
        } else {
            console.log("sg_ss: (Chrome did not produce sg_ss URL — skip)");
        }

        if (seiUrl) {
            report.curl.sei = curlProbe("sei", seiUrl);
            console.log("sei HEAD:", report.curl.sei.head);
            console.log("sei GET: ", report.curl.sei.get.slice(0, 100));
            console.log("sei -L:  ", report.curl.sei.followStatus, report.curl.sei.followUrl || "");
        }

        await mkdir(OUT, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const outDir = resolve(OUT, `chrome-sgss-curl-${stamp}`);
        await mkdir(outDir, { recursive: true });
        if (sgUrl) await writeFile(resolve(outDir, "chrome-sg-ss-url.txt"), sgUrl);
        if (seiUrl) await writeFile(resolve(outDir, "chrome-sei-url.txt"), seiUrl);
        await writeFile(resolve(outDir, "report.json"), JSON.stringify(report, null, 2));
        console.log(`\nsaved: ${outDir}`);
    } finally {
        killProc(chromeProc);
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});