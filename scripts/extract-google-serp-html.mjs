#!/usr/bin/env node
/**
 * Extract a probe-friendly SERP shell from a captured Google page.html.
 *
 * Pulls the #rcnt subtree (~300KB) instead of the full 1.2MB document,
 * normalizes rhs sidebar id for errsrp probes, and wraps a minimal document.
 *
 * Usage:
 *   node scripts/extract-google-serp-html.mjs \
 *     "/path/to/playwright-capture/page.html" \
 *     --out code-check/tmp/google-serp-rcnt.html
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function parseArgs(argv) {
    let input = null;
    let out = resolve("code-check/tmp/google-serp-rcnt.html");
    let skeleton = false;
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--out") out = resolve(argv[++i]);
        else if (argv[i] === "--skeleton") skeleton = true;
        else if (!argv[i].startsWith("-")) input = resolve(argv[i]);
    }
    if (!input) {
        throw new Error("Usage: node extract-google-serp-html.mjs <page.html> [--out path] [--skeleton]");
    }
    return { input, out, skeleton };
}

function extractOuterHtml(html, marker) {
    const idx = html.indexOf(marker);
    if (idx < 0) throw new Error(`marker not found: ${marker}`);
    const start = html.lastIndexOf("<div", idx);
    if (start < 0) throw new Error("rcnt <div> start not found");

    let depth = 0;
    let i = start;
    while (i < html.length) {
        if (html.startsWith("<div", i)) {
            depth += 1;
            i += 4;
            continue;
        }
        if (html.startsWith("</div", i)) {
            depth -= 1;
            if (depth === 0) return html.slice(start, i + 6);
            i += 5;
            continue;
        }
        i += 1;
    }
    throw new Error("rcnt closing </div> not found");
}

function normalizeRhs(html) {
    return html
        .replace(
            'data-container-id="rhs-col"',
            'id="rhs" data-container-id="rhs-col"',
        )
        .replace('id="rhs-col"', 'id="rhs"');
}

/** Drop executable content so Velora can layout-probe without xjs/BotGuard hangs. */
function stripExecutable(html) {
    return html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/\sjsaction="[^"]*"/gi, "")
        .replace(/\sjscontroller="[^"]*"/gi, "")
        .replace(/\son\w+="[^"]*"/gi, "");
}

function buildProbeShell(rcntHtml, title = "Google SERP probe") {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${rcntHtml}</body></html>`;
}

function openTagFor(html, marker) {
    const idx = html.indexOf(marker);
    if (idx < 0) return null;
    const start = html.lastIndexOf("<", idx);
    const end = html.indexOf(">", idx);
    if (start < 0 || end < 0) return null;
    return html.slice(start, end + 1);
}

function fillerBlocks(count, className = "g") {
    return Array.from({ length: count }, () => `<div class="${className}">result</div>`).join("");
}

/** Lightweight DOM shell: real center_col/rhs tags, synthetic children for height. */
function buildSkeleton(raw) {
    const rcntTag = openTagFor(raw, 'id="rcnt"') ?? '<div id="rcnt">';
    const centerTag = openTagFor(raw, 'id="center_col"') ?? '<div id="center_col" role="main">';
    const rhsNeedle = 'id="rhs"';
    const rhsTag = openTagFor(raw, rhsNeedle)
        ?? openTagFor(raw, 'data-container-id="rhs-col"')?.replace(
            'data-container-id="rhs-col"',
            'id="rhs" data-container-id="rhs-col"',
        )
        ?? '<div id="rhs">';
    const centerBody = fillerBlocks(18);
    const rhsBody = fillerBlocks(4, "rhs-block");
    return `${rcntTag}${centerTag}${centerBody}</div>${rhsTag}${rhsBody}</div></div>`;
}

function main() {
    const { input, out, skeleton } = parseArgs(process.argv.slice(2));
    const raw = readFileSync(input, "utf8");
    const rcnt = skeleton
        ? buildSkeleton(raw)
        : stripExecutable(normalizeRhs(extractOuterHtml(raw, 'id="rcnt"')));
    const title = (raw.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1]?.trim() || "Google SERP probe";
    const shell = buildProbeShell(rcnt, title);
    writeFileSync(out, shell, "utf8");

    const report = {
        input,
        out,
        skeleton,
        bytes: Buffer.byteLength(shell, "utf8"),
        rcntBytes: Buffer.byteLength(rcnt, "utf8"),
        hasCenterCol: rcnt.includes('id="center_col"'),
        hasRhs: rcnt.includes('id="rhs"'),
        title,
    };
    console.log(JSON.stringify(report, null, 2));
}

main();