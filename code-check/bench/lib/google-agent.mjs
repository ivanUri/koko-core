import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { arch, cpus, hostname, platform, release } from "node:os";

import { repoRoot } from "./crawl-wikipedia.mjs";

export const DEFAULT_QUERIES = [
    "rust programming book",
    "openstreetmap api",
    "zig language tutorial",
    "python asyncio guide",
    "postgresql indexing",
    "kubernetes ingress controller",
    "climate change IPCC report",
    "machine learning fundamentals",
    "webassembly tutorial",
    "distributed systems textbook",
];

export const GOOGLE_TTFX_EXPR = `(() => {
  const h3 = document.querySelector("#search a h3, #rso a h3, a h3");
  if (h3?.innerText?.trim()) return h3.innerText.trim();
  const t = document.title || "";
  if (t.includes("Google Search") && !t.startsWith("http")) return t;
  if (t && !t.startsWith("http") && !t.includes("/sorry")) return t;
  return null;
})()`;

export function buildGoogleExtractExpr(limit = 5) {
    return `(() => {
  const out = [];
  const seen = new Set();
  const roots = [...document.querySelectorAll("a h3")].map((h) => h.closest("a")).filter(Boolean);
  for (const a of roots) {
    const h3 = a.querySelector("h3");
    const title = h3?.innerText?.trim();
    let href = a.href || "";
    if (!title || !href) continue;
    if (href.includes("google.com/search") || href.includes("/sorry")) continue;
    if (seen.has(href)) continue;
    seen.add(href);
    out.push({ title, url: href });
    if (out.length >= ${limit}) break;
  }
  const html = document.documentElement.innerHTML;
  const blocked = /google\\.com\\/sorry|unusual traffic from your computer/i.test(html)
    || /accounts\\.google\\.com\\/v3\\/signin/i.test(location.href);
  return {
    title: document.title,
    resultCount: out.length,
    results: out,
    linkCount: out.length,
    htmlBytes: html.length,
    pathHint: {
      bodyLen: html.length,
      hasKnitsail: html.includes("knitsail"),
      hasSclm: /sclm=/.test(html),
      blocked,
      shortSerp: !blocked && html.length > 120000 && !html.includes("knitsail"),
    },
  };
})()`;
}

export function validateGoogleExtract(data) {
    if (!data || typeof data !== "object") throw new Error("invalid extract");
    if (data.pathHint?.blocked) throw new Error("blocked: sorry or captcha");
    if (!data.resultCount || data.resultCount < 1) {
        throw new Error(`no organic results (title=${data.title || "?"})`);
    }
}

export function buildSearchUrl(query, hl = "en") {
    const params = new URLSearchParams({ q: query, hl });
    return `https://www.google.com/search?${params}`;
}

export function buildQueryQueue(queries) {
    return queries.map((query, i) => ({
        i,
        title: query,
        url: buildSearchUrl(query),
    }));
}

export function loadOrFetchQueries(opts) {
    if (opts.queriesFile && existsSync(opts.queriesFile)) {
        const data = JSON.parse(readFileSync(opts.queriesFile, "utf8"));
        const list = Array.isArray(data) ? data : data.queries;
        if (Array.isArray(list) && list.length) return list;
    }
    return null;
}

export function saveQueries(file, queries) {
    writeFileSync(file, `${JSON.stringify({ queries, savedAt: new Date().toISOString() }, null, 2)}\n`);
}

export function collectGoogleMeta(opts) {
    let gitSha = null;
    try {
        gitSha = execSync("git rev-parse --short HEAD", { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] })
            .toString()
            .trim();
    } catch (_) {}

    const cpu = cpus()[0];
    return {
        timestamp: new Date().toISOString(),
        benchmarkName: "Google agent search benchmark",
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        osRelease: release(),
        cpu: cpu ? `${cpu.model} (${cpus().length} cores)` : null,
        node: process.version,
        gitSha,
        site: "https://www.google.com/search",
        limit: opts.limit,
        concurrency: opts.concurrency,
        resultLimit: opts.resultLimit,
        mode: "agent-search",
        veloraProfile: opts.browserProfile,
        chromiumTarget: "playwright-chromium-headless",
        benchmarkClass: "agent-search",
        interItemDelayMs: opts.interItemDelayMs,
        note: "Velora uses warmed profile cookies; Chromium runs without Google session jar.",
    };
}

export function summarizePathHints(results) {
    const ok = results.filter((r) => r.ok);
    return {
        shortSerp: ok.filter((r) => r.pathHint?.shortSerp).length,
        longBootstrap: ok.filter((r) => r.pathHint?.hasKnitsail || r.pathHint?.hasSclm).length,
        blocked: results.filter((r) => !r.ok && /blocked|sorry/i.test(r.error || "")).length,
        otherFail: results.filter((r) => !r.ok && !/blocked|sorry/i.test(r.error || "")).length,
        meanResults: ok.length
            ? ok.reduce((s, r) => s + (r.resultCount ?? r.linkCount ?? 0), 0) / ok.length
            : 0,
    };
}