import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { repoRoot } from "./crawl-wikipedia.mjs";

export const HN_TTFX_EXPR = `(() => {
    const el = document.querySelector(".fatitem .titleline a")
        || document.querySelector(".titleline a")
        || document.querySelector("td.title a");
    const fromEl = el?.textContent?.trim();
    if (fromEl) return fromEl;
    const fromTitle = document.title.replace(/ \\| Hacker News$/, "").trim();
    return fromTitle && fromTitle !== "Hacker News" ? fromTitle : null;
})()`;

export const HN_EXTRACT_EXPR = `(() => {
    const titleEl = document.querySelector(".titleline a")
        || document.querySelector(".fatitem .title")
        || document.querySelector("td.title a");
    const title = titleEl?.textContent?.trim() || document.title.replace(/ \\| Hacker News$/, "").trim();
    const score = document.querySelector(".score")?.textContent?.trim() || null;
    const comments = document.querySelector(".fatitem")?.textContent?.length
        || document.querySelector(".commtext")?.textContent?.length
        || 0;
    const links = document.querySelectorAll("a[href]").length;
    return { title, score, comments, linkCount: links };
})()`;

export async function fetchTopStoryIds(limit) {
    const res = await fetch("https://hacker-news.firebaseio.com/v0/topstories.json", {
        headers: { "user-agent": "velora-crawl-benchmark/1.0 (research; contact: local)" },
    });
    if (!res.ok) throw new Error(`hn api ${res.status}`);
    const ids = await res.json();
    if (!Array.isArray(ids) || ids.length === 0) throw new Error("hn api returned no ids");
    return ids.slice(0, limit);
}

export function buildHnQueue(ids) {
    return ids.map((id, i) => ({
        i,
        title: `hn-${id}`,
        url: `https://news.ycombinator.com/item?id=${id}`,
        storyId: id,
    }));
}

export function loadOrFetchIds(opts) {
    if (opts.titlesFile && existsSync(opts.titlesFile)) {
        const data = JSON.parse(readFileSync(opts.titlesFile, "utf8"));
        return data.ids.slice(0, opts.limit);
    }
    return null;
}

export function saveIds(path, ids) {
    const dir = resolve(path, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify({ fetchedAt: new Date().toISOString(), ids }, null, 2)}\n`);
}

export function hnCollectMeta(opts) {
    return {
        benchmarkName: "Agent extract: Hacker News",
        benchmarkClass: "agent-extract",
        site: "https://news.ycombinator.com/",
        limit: opts.limit,
        concurrency: opts.concurrency,
        mode: opts.mode,
        veloraProfile: opts.browserProfile,
        chromiumTarget: "playwright-chromium-headless",
    };
}

export function hnExpressions() {
    return {
        ttfx: HN_TTFX_EXPR,
        extract: HN_EXTRACT_EXPR,
        validate: (value) => {
            if (!value.title || value.title.length < 2) {
                throw new Error(`weak hn data: title=${value.title}`);
            }
        },
    };
}