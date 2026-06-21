import { type BrowserConnectOptions } from "./browser.js";
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
export declare function createCrawlWorker(options: CrawlWorkerOptions): Promise<CrawlWorker>;
