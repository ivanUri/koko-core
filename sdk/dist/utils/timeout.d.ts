export interface TimeoutOptions {
    timeout?: number;
    label?: string;
    method?: string;
    sessionId?: string;
}
export declare function withTimeout<T>(promise: Promise<T>, options?: TimeoutOptions): Promise<T>;
export declare function delay(ms: number): Promise<void>;
