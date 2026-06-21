import type { CDPSession } from "../cdp/session.js";
export interface NetworkRequest {
    requestId: string;
    url: string;
    method?: string;
    timestamp?: number;
    redirectChain: string[];
    response?: NetworkResponse;
    failureText?: string;
}
export interface NetworkResponse {
    url: string;
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
}
export declare class NetworkTracker {
    private readonly session;
    readonly requests: Map<string, NetworkRequest>;
    readonly inflight: Set<string>;
    private cleanup;
    private readonly listeners;
    private maxRequests;
    constructor(session: CDPSession);
    setMaxRequests(max: number): void;
    private notify;
    enable(): Promise<void>;
    dispose(): void;
    /** Clear tracked requests (e.g. at navigation start). */
    reset(): void;
    waitForIdle(options?: {
        idleMs?: number;
        timeout?: number;
    }): Promise<void>;
    private onRequest;
    private onResponse;
    private onDone;
    private onFailed;
    private pruneCompleted;
}
