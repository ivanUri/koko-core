import type { CDPSession } from "../cdp/session.js";
import type { NetworkTracker } from "./network.js";
export type WaitUntil = "none" | "commit" | "domcontentloaded" | "load" | "networkidle" | "done";
export interface GotoWaitOptions {
    waitUntil?: WaitUntil;
    timeout?: number;
    networkIdleMs?: number;
}
export interface InternalWaitOptions extends GotoWaitOptions {
    /** loaderId returned by Page.navigate; used to disambiguate concurrent navigations. */
    loaderId?: string;
    /** frameId returned by Page.navigate (main frame). */
    frameId?: string;
}
export declare class PageWaiter {
    private readonly session;
    private readonly network;
    constructor(session: CDPSession, network: NetworkTracker);
    waitForNavigation(options?: InternalWaitOptions): Promise<void>;
    waitForSelector(selector: string, options?: {
        timeout?: number;
        visible?: boolean;
    }): Promise<void>;
    waitForFunction(fn: string | Function, options?: {
        timeout?: number;
        pollingMs?: number;
    }): Promise<void>;
    /** Poll until a return-by-value expression is truthy (adaptive interval). */
    pollUntilTruthy(expression: string, options?: {
        timeout?: number;
        label?: string;
    }): Promise<void>;
    waitForURL(url: string | RegExp | ((url: string) => boolean), options?: {
        timeout?: number;
    }): Promise<void>;
    private pollDomSearch;
    private pollExpression;
}
