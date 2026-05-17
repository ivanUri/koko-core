import type { CDPSession } from "../cdp/session.js";
import type { NetworkTracker } from "./network.js";
export type WaitUntil = "none" | "commit" | "domcontentloaded" | "load" | "networkidle";
export interface GotoWaitOptions {
    waitUntil?: WaitUntil;
    timeout?: number;
    networkIdleMs?: number;
}
export declare class PageWaiter {
    private readonly session;
    private readonly network;
    constructor(session: CDPSession, network: NetworkTracker);
    waitForNavigation(options?: GotoWaitOptions): Promise<void>;
    waitForSelector(selector: string, options?: {
        timeout?: number;
        visible?: boolean;
    }): Promise<void>;
    waitForFunction(fn: string | Function, options?: {
        timeout?: number;
        pollingMs?: number;
    }): Promise<void>;
    private pollExpression;
}
