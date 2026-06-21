import { Browser, type BrowserConnectOptions } from "./browser.js";
import type { ExtractOptions, ExtractResult } from "./page.js";
import type { GotoWaitOptions } from "./waiter.js";

export interface CrawlItem {
  i: number;
  title: string;
  url: string;
}

export interface CrawlPageResult extends ExtractResult {
  ok: boolean;
  idx: number;
  title: string;
  url: string;
  ms: number;
  worker: number;
  domReadyMs?: number;
  ttfexMs?: number;
  extractMs?: number;
  totalMs?: number;
  error?: string;
}

export interface CrawlWorkerOptions {
  endpoint: string;
  timeoutMs?: number;
  goto?: GotoWaitOptions;
  extract?: ExtractOptions;
  connect?: BrowserConnectOptions;
}

export interface CrawlWorker {
  fetch(item: CrawlItem): Promise<CrawlPageResult>;
  close(): Promise<void>;
}

/** One Browser + Page per worker — matches multi-process crawl benchmark shape. */
export async function createCrawlWorker(options: CrawlWorkerOptions): Promise<CrawlWorker> {
  const browser = await Browser.connect(options.endpoint, options.connect);
  const page = await browser.newPage();
  const timeoutMs = options.timeoutMs ?? 45_000;
  const gotoOpts: GotoWaitOptions = {
    waitUntil: options.goto?.waitUntil ?? "domcontentloaded",
    timeout: options.goto?.timeout ?? timeoutMs,
    networkIdleMs: options.goto?.networkIdleMs,
  };
  const extractOpts = options.extract ?? {};

  return {
    async fetch(item) {
      const t0 = Date.now();
      try {
        await page.goto(item.url, gotoOpts);
        const domReadyMs = Date.now() - t0;
        const ttf0 = Date.now();
        const data = await page.extract({ ...extractOpts, timeout: timeoutMs });
        const ttfexMs = Date.now() - t0;
        const extractMs = Date.now() - ttf0;
        const totalMs = Date.now() - t0;
        return {
          ok: true,
          idx: item.i,
          title: item.title,
          url: item.url,
          ms: totalMs,
          worker: 0,
          domReadyMs,
          ttfexMs,
          extractMs,
          totalMs,
          ...data,
        };
      } catch (err) {
        return {
          ok: false,
          idx: item.i,
          title: item.title,
          url: item.url,
          ms: Date.now() - t0,
          worker: 0,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
    async close() {
      await browser.close();
    },
  };
}