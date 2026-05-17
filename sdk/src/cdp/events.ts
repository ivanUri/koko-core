export type EventHandler<T = unknown> = (payload: T) => void;
export type WildcardEventHandler = (event: string, payload: unknown) => void;

export class EventBus {
  private readonly listeners = new Map<string, Set<EventHandler>>();
  private readonly wildcard = new Set<WildcardEventHandler>();

  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    const set = this.listeners.get(event) ?? new Set<EventHandler>();
    set.add(handler as EventHandler);
    this.listeners.set(event, set);
    return () => this.off(event, handler);
  }

  once<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    const off = this.on<T>(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  onAny(handler: WildcardEventHandler): () => void {
    this.wildcard.add(handler);
    return () => this.wildcard.delete(handler);
  }

  off<T = unknown>(event: string, handler: EventHandler<T>): void {
    this.listeners.get(event)?.delete(handler as EventHandler);
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.listeners.get(event) ?? []) handler(payload);
    for (const handler of this.wildcard) handler(event, payload);
  }

  removeAll(): void {
    this.listeners.clear();
    this.wildcard.clear();
  }
}
