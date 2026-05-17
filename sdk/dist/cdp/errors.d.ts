export interface ProtocolErrorContext {
    method?: string;
    sessionId?: string;
    timeout?: number;
    payload?: unknown;
}
export declare class CDPError extends Error {
    readonly method?: string;
    readonly sessionId?: string;
    readonly timeout?: number;
    readonly payload?: unknown;
    constructor(message: string, context?: ProtocolErrorContext);
}
export declare class TimeoutError extends CDPError {
}
export declare class ProtocolError extends CDPError {
}
export declare class NavigationError extends CDPError {
}
export declare class TargetClosedError extends CDPError {
}
export declare class WebSocketClosedError extends CDPError {
}
