import type { CDPSession } from "../cdp/session.js";
export interface RouteRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    postData?: string;
}
export interface RouteFulfillOptions {
    status?: number;
    headers?: Record<string, string>;
    body?: string | Buffer;
    contentType?: string;
}
export declare class Route {
    private readonly session;
    readonly requestId: string;
    readonly request: RouteRequest;
    private handled;
    constructor(session: CDPSession, requestId: string, request: RouteRequest);
    continue(options?: {
        headers?: Record<string, string>;
        postData?: string;
        url?: string;
    }): Promise<void>;
    abort(errorReason?: "Aborted" | "BlockedByClient"): Promise<void>;
    fulfill(options?: RouteFulfillOptions): Promise<void>;
    private ensureOnce;
}
export type RouteHandler = (route: Route) => void | Promise<void>;
export type RoutePattern = string | RegExp | ((url: string) => boolean);
export declare function matchesRoutePattern(url: string, pattern: RoutePattern): boolean;
export declare class RouteRegistry {
    private readonly session;
    private fetchEnabled;
    private readonly handlers;
    private unsubscribe?;
    constructor(session: CDPSession);
    route(pattern: RoutePattern, handler: RouteHandler): Promise<void>;
    unroute(pattern?: RoutePattern, handler?: RouteHandler): Promise<void>;
    dispose(): void;
    private ensureFetchEnabled;
    private onRequestPaused;
}
