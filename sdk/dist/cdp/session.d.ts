import type { CDPClient } from "./client.js";
import type { EventHandler } from "./events.js";
export declare class CDPSession {
    readonly client: CDPClient;
    readonly sessionId: string;
    readonly targetId?: string | undefined;
    constructor(client: CDPClient, sessionId: string, targetId?: string | undefined);
    send<T = unknown>(method: string, params?: unknown, timeout?: number): Promise<T>;
    on<T = unknown>(event: string, handler: EventHandler<T>): () => void;
    once<T = unknown>(event: string, handler: EventHandler<T>): () => void;
    waitFor<T = unknown>(event: string, options?: {
        timeout?: number;
        predicate?: (payload: T) => boolean;
    }): Promise<T>;
    detach(): Promise<void>;
}
