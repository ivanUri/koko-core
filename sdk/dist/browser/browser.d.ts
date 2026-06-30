import { CDPClient } from "../cdp/client.js";
import type { WebSocketTransportOptions } from "../transport/websocket.js";
import { BrowserContext, type BrowserContextOptions } from "./context.js";
import { Page } from "./page.js";
import { type LaunchedVelora, type VeloraLaunchOptions } from "./launch.js";
export interface BrowserConnectOptions extends WebSocketTransportOptions {
    /** Enable Target.setDiscoverTargets + setAutoAttach (default: true). */
    enableTargetTracking?: boolean;
}
export declare class Browser {
    readonly client: CDPClient;
    private readonly pages;
    private readonly _contexts;
    private constructor();
    static connect(endpoint: string, options?: BrowserConnectOptions): Promise<Browser>;
    /**
     * Spawn a Velora server with antidetect profile/cookies and connect over CDP.
     * Requires `zig-out/bin/velora` (run `zig build` first).
     */
    static launch(options?: VeloraLaunchOptions): Promise<LaunchedVelora>;
    newSession(url?: string): Promise<import("../index.js").CDPSession>;
    newPage(url?: string): Promise<Page>;
    newContext(options?: BrowserContextOptions): BrowserContext;
    contexts(): BrowserContext[];
    releaseContext(context: BrowserContext): void;
    close(): Promise<void>;
}
