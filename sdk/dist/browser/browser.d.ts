import { CDPClient } from "../cdp/client.js";
import type { WebSocketTransportOptions } from "../transport/websocket.js";
import { BrowserContext } from "./context.js";
import { Page } from "./page.js";
export interface BrowserConnectOptions extends WebSocketTransportOptions {
    /** Enable Target.setDiscoverTargets + setAutoAttach (default: true). */
    enableTargetTracking?: boolean;
}
export declare class Browser {
    readonly client: CDPClient;
    private readonly pages;
    private constructor();
    static connect(endpoint: string, options?: BrowserConnectOptions): Promise<Browser>;
    newSession(url?: string): Promise<import("../index.js").CDPSession>;
    newPage(url?: string): Promise<Page>;
    newContext(): BrowserContext;
    close(): Promise<void>;
}
