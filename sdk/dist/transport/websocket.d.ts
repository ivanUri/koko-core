import { type EventHandler, type WildcardEventHandler } from "../cdp/events.js";
import { type LoggerOption } from "../utils/logger.js";
export interface CDPMessage {
    id?: number;
    method?: string;
    params?: unknown;
    sessionId?: string;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}
export interface TransportSendOptions {
    timeout?: number;
    sessionId?: string;
}
export interface WebSocketTransportOptions {
    defaultTimeout?: number;
    logger?: LoggerOption;
}
export declare class WebSocketTransport {
    private readonly socket;
    private nextId;
    private readonly pending;
    private readonly events;
    private readonly defaultTimeout;
    private readonly logger?;
    private closed;
    private constructor();
    static connect(endpoint: string, options?: WebSocketTransportOptions): Promise<WebSocketTransport>;
    send<T = unknown>(method: string, params?: unknown, options?: TransportSendOptions): Promise<T>;
    on<T = unknown>(event: string, handler: EventHandler<T>): () => void;
    once<T = unknown>(event: string, handler: EventHandler<T>): () => void;
    onAny(handler: WildcardEventHandler): () => void;
    off<T = unknown>(event: string, handler: EventHandler<T>): void;
    close(): void;
    private bindSocket;
    private handleMessage;
    private rejectAll;
}
