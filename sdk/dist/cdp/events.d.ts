export type EventHandler<T = unknown> = (payload: T) => void;
export type WildcardEventHandler = (event: string, payload: unknown) => void;
export declare class EventBus {
    private readonly listeners;
    private readonly wildcard;
    on<T = unknown>(event: string, handler: EventHandler<T>): () => void;
    once<T = unknown>(event: string, handler: EventHandler<T>): () => void;
    onAny(handler: WildcardEventHandler): () => void;
    off<T = unknown>(event: string, handler: EventHandler<T>): void;
    emit(event: string, payload: unknown): void;
    removeAll(): void;
}
