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
    constructor(session: CDPSession);
    private notify;
    enable(): Promise<void>;
    dispose(): void;
    waitForIdle(options?: {
        idleMs?: number;
        timeout?: number;
    }): Promise<void>;
    private onRequest;
    private onResponse;
    private onDone;
    private onFailed;
}
