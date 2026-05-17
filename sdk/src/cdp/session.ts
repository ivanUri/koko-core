import type { CDPClient } from "./client.js";
import type { EventHandler } from "./events.js";

export class CDPSession {
  constructor(
    readonly client: CDPClient,
    readonly sessionId: string,
    readonly targetId?: string,
  ) {}

  send<T = unknown>(method: string, params?: unknown, timeout?: number): Promise<T> {
    return this.client.send<T>(method, params, this.sessionId, timeout);
  }

  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    return this.client.onSession(this.sessionId, event, handler);
  }

  once<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    return this.client.onceSession(this.sessionId, event, handler);
  }

  waitFor<T = unknown>(event: string, options?: { timeout?: number; predicate?: (payload: T) => boolean }): Promise<T> {
    return this.client.waitForSession<T>(this.sessionId, event, options);
  }

  detach(): Promise<void> {
    return this.client.detachSession(this.sessionId);
  }
}
