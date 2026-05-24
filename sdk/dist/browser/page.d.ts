import type { CDPSession } from "../cdp/session.js";
import type { GotoWaitOptions } from "./waiter.js";
import { PageWaiter } from "./waiter.js";
import { NetworkTracker } from "./network.js";
export interface EvaluateOptions {
    timeout?: number;
}
export declare class Page {
    readonly session: CDPSession;
    readonly network: NetworkTracker;
    readonly waiter: PageWaiter;
    private initialized;
    private mainFrameId?;
    constructor(session: CDPSession);
    init(): Promise<void>;
    goto(url: string, options?: GotoWaitOptions): Promise<void>;
    evaluate<T = unknown>(expressionOrFunction: string | Function, options?: EvaluateOptions): Promise<T>;
    content(): Promise<string>;
    waitForSelector(selector: string, options?: {
        timeout?: number;
        visible?: boolean;
    }): Promise<void>;
    waitForFunction(fn: string | Function, options?: {
        timeout?: number;
        pollingMs?: number;
    }): Promise<void>;
    close(): Promise<void>;
    /** Returns the main-frame id (after first navigation/init). */
    get frameId(): string | undefined;
    private contentFromDOM;
}
