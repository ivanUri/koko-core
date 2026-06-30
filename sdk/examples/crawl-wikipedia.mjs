#!/usr/bin/env node
/**
 * Production-style Wikipedia crawl using @velora/sdk createCrawlWorker.
 *
 * Usage:
 *   npm run example:crawl
 *   VELORA_CDP=http://127.0.0.1:9222 node sdk/examples/crawl-wikipedia.mjs --limit 20 --concurrency 4
 *   node sdk/examples/crawl-wikipedia.mjs --launch --profile chrome-local-huys-macbook-pro
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { Browser, createCrawlWorker } from "../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "../..");

const TTFX = `(() => {
  const el = document.querySelector("#firstHeading") || document.querySelector("h1");
  return el?.textContent?.trim() || null;
})()`;

const EXTRACT = `(() => {
  const links = document.querySelectorAll('a[href^="/wiki/"]:not([href*=":"])');
  const title = document.querySelector("#firstHeading")?.textContent?.trim()
    || document.title.replace(/ - Wikipedia$/, "").trim();
  return { title, linkCount: links.length, htmlBytes: document.documentElement?.outerHTML?.length ?? 0 };
})()`;

const DEFAULT_TITLES = ["Earth", "Moon", "Mars", "Jupiter", "Saturn", "Venus", "Mercury_(planet)", "Sun"];

function parseArgs(argv) {
  const out = {
    launch: false,
    profile: process.env.VELORA_PROFILE ?? "chrome-local-huys-macbook-pro",
    endpoint: process.env.VELORA_CDP ?? null,
    limit: 8,
    concurrency: 2,
    lang: "en",
    timeoutMs: 30_000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--launch") out.launch = true;
    else if (a === "--profile") out.profile = argv[++i];
    else if (a === "--endpoint") out.endpoint = argv[++i];
    else if (a === "--limit") out.limit = Number(argv[++i]);
    else if (a === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (a === "--lang") out.lang = argv[++i];
    else if (a === "--timeout") out.timeoutMs = Number(argv[++i]);
    else if (a === "--help") {
      console.log("Usage: node sdk/examples/crawl-wikipedia.mjs [--launch] [--limit N] [--concurrency N]");
      process.exit(0);
    }
  }
  return out;
}

async function fetchTitles(lang, limit) {
  const api = `https://${lang}.wikipedia.org/w/api.php?action=query&list=random&rnnamespace=0&rnlimit=${limit}&format=json&origin=*`;
  const res = await fetch(api, { headers: { "user-agent": "velora-sdk-crawl-example/1.0" } });
  const data = await res.json();
  const titles = (data?.query?.random ?? []).map((r) => r.title);
  return titles.length ? titles : DEFAULT_TITLES.slice(0, limit);
}

function buildQueue(titles, lang) {
  return titles.map((title, i) => ({
    i,
    title,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
  }));
}

async function runPool(items, concurrency, workerFactory) {
  const workers = await Promise.all(Array.from({ length: concurrency }, (_, w) => workerFactory(w)));
  const results = [];
  let cursor = 0;
  async function runOne(worker, w) {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      const item = items[idx];
      const row = await worker.fetch({ ...item, i: idx });
      results.push({ ...row, worker: w });
      const status = row.ok ? "ok" : "ERR";
      console.log(`[${status}] w${w} ${row.title ?? item.title} ttfex=${row.ttfexMs ?? "?"}ms links=${row.linkCount ?? "?"}`);
    }
  }
  await Promise.all(workers.map((worker, w) => runOne(worker, w)));
  await Promise.all(workers.map((w) => w.close()));
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let launched = null;
  let endpoint = args.endpoint;

  if (!endpoint) {
    if (args.launch) {
      if (!existsSync(resolve(REPO, "zig-out/bin/velora"))) throw new Error("run zig build first");
      launched = await Browser.launch({ profile: args.profile, logLevel: "warn" });
      endpoint = launched.endpoint;
      console.log(`launched ${endpoint} profile=${args.profile}`);
    } else {
      throw new Error("set VELORA_CDP or pass --launch");
    }
  }

  const titles = await fetchTitles(args.lang, args.limit);
  const queue = buildQueue(titles, args.lang);
  console.log(`crawl ${queue.length} articles concurrency=${args.concurrency}`);

  const t0 = Date.now();
  const results = await runPool(queue, args.concurrency, () =>
    createCrawlWorker({
      endpoint,
      timeoutMs: args.timeoutMs,
      goto: { waitUntil: "done", timeout: args.timeoutMs },
      extract: { ttfx: TTFX, expression: EXTRACT, timeout: args.timeoutMs },
    }),
  );

  const ok = results.filter((r) => r.ok);
  const ttfex = ok.map((r) => r.ttfexMs).filter((n) => n != null);
  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

  const summary = {
    total: results.length,
    success: ok.length,
    failed: results.length - ok.length,
    wallMs: Date.now() - t0,
    meanTtfexMs: Math.round(mean(ttfex)),
    meanExtractMs: Math.round(mean(ok.map((r) => r.extractMs))),
    throughputPerMin: ((ok.length / (Date.now() - t0)) * 60_000).toFixed(1),
  };

  console.log("\n--- crawl summary ---");
  console.log(JSON.stringify(summary, null, 2));
  if (launched) await launched.close();
  process.exitCode = summary.failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});