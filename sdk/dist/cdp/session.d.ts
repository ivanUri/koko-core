import type { CDPClient } from "./client.js";
import { CDPError } from "./errors.js";
import type { EventHandler } from "./events.js";
export declare class CDPSession {
    readonly client: CDPClient;
    readonly sessionId: string;
    readonly targetId?: string | undefined;
    private _closed?;
    private readonly _pending;
    constructor(client: CDPClient, sessionId: string, targetId?: string | undefined);
    get closed(): CDPError | undefined;
    send<T = unknown>(method: string, params?: unknown, timeout?: number): Promise<T>;
    on<T = unknown>(event: string, handler: EventHandler<T>): () => void;
    once<T = unknown>(event: string, handler: EventHandler<T>): () => void;
    waitFor<T = unknown>(event: string, options?: {
        timeout?: number;
        predicate?: (payload: T) => boolean;
    }): Promise<T>;
    /** Internal: mark session as closed and reject all in-flight requests. */
    markClosed(reason?: CDPError): void;
    detach(): Promise<void>;
}
