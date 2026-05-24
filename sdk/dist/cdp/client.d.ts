import { WebSocketTransport, type WebSocketTransportOptions } from "../transport/websocket.js";
import type { EventHandler, WildcardEventHandler } from "./events.js";
import { CDPSession } from "./session.js";
export interface WaitForEventOptions<T> {
    timeout?: number;
    predicate?: (payload: T) => boolean;
}
export declare class CDPClient {
    readonly transport: WebSocketTransport;
    readonly sessions: Map<string, CDPSession>;
    private targetTrackingStarted;
    private constructor();
    static connect(endpoint: string, options?: WebSocketTransportOptions): Promise<CDPClient>;
    private bindLifecycle;
    /** Enable global Target.* tracking (discover + auto-attach flatten). Call once after connect. */
    enableTargetTracking(options?: {
        autoAttach?: boolean;
        discover?: boolean;
    }): Promise<void>;
    send<T = unknown>(method: string, params?: unknown, sessionId?: string, timeout?: number): Promise<T>;
    on<T = unknown>(event: string, handler: EventHandler<T>): () => void;
    once<T = unknown>(event: string, handler: EventHandler<T>): () => void;
    off<T = unknown>(event: string, handler: EventHandler<T>): void;
    onAny(handler: WildcardEventHandler): () => void;
    waitFor<T = unknown>(event: string, options?: WaitForEventOptions<T>): Promise<T>;
    onSession<T = unknown>(sessionId: string, event: string, handler: EventHandler<T>): () => void;
    onceSession<T = unknown>(sessionId: string, event: string, handler: EventHandler<T>): () => void;
    waitForSession<T = unknown>(sessionId: string, event: string, options?: WaitForEventOptions<T>): Promise<T>;
    createTarget(url?: string): Promise<string>;
    attachToTarget(targetId: string): Promise<CDPSession>;
    newSession(url?: string): Promise<CDPSession>;
    detachSession(sessionId: string): Promise<void>;
    closeTarget(targetId: string): Promise<void>;
    close(): void;
}
