import type { CDPSession } from "../cdp/session.js";
import type { GotoWaitOptions } from "./waiter.js";
import { PageWaiter } from "./waiter.js";
import { NetworkTracker } from "./network.js";
export interface EvaluateOptions {
    timeout?: number;
}
export interface ExtractOptions {
    /** Expression that must become truthy before extract runs (TTFX probe). */
    ttfx?: string;
    /** Final extract expression; must returnByValue. */
    expression?: string;
    timeout?: number;
    pollMs?: number;
}
export interface ExtractResult {
    title?: string;
    linkCount?: number;
    htmlBytes?: number;
    [key: string]: unknown;
}
export declare class Page {
    readonly session: CDPSession;
    readonly network: NetworkTracker;
    readonly waiter: PageWaiter;
    private initialized;
    private mainFrameId?;
    private readonly closeHooks;
    constructor(session: CDPSession);
    /** Register cleanup when page.close() runs (used by Browser/Context). */
    onClose(hook: () => void): void;
    init(): Promise<void>;
    goto(url: string, options?: GotoWaitOptions): Promise<void>;
    evaluate<T = unknown>(expressionOrFunction: string | Function, options?: EvaluateOptions): Promise<T>;
    /** Single round-trip HTML snapshot (doctype + outerHTML). */
    content(): Promise<string>;
    /**
     * Crawler helper: wait for a TTFX probe then run a structured extract expression.
     * Defaults match the Wikipedia crawl benchmark.
     */
    extract(options?: ExtractOptions): Promise<ExtractResult>;
    waitForSelector(selector: string, options?: {
        timeout?: number;
        visible?: boolean;
    }): Promise<void>;
    waitForFunction(fn: string | Function, options?: {
        timeout?: number;
        pollingMs?: number;
    }): Promise<void>;
    close(): Promise<void>;
    get frameId(): string | undefined;
}
