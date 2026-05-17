import { WebSocketTransport, type CDPMessage, type WebSocketTransportOptions } from "../transport/websocket.js";
import { withTimeout } from "../utils/timeout.js";
import type { EventHandler, WildcardEventHandler } from "./events.js";
import { CDPSession } from "./session.js";

export interface WaitForEventOptions<T> {
  timeout?: number;
  predicate?: (payload: T) => boolean;
}

export class CDPClient {
  readonly sessions = new Map<string, CDPSession>();

  private constructor(readonly transport: WebSocketTransport) {}

  static async connect(endpoint: string, options: WebSocketTransportOptions = {}): Promise<CDPClient> {
    return new CDPClient(await WebSocketTransport.connect(endpoint, options));
  }

  send<T = unknown>(method: string, params?: unknown, sessionId?: string, timeout?: number): Promise<T> {
    return this.transport.send<T>(method, params, { sessionId, timeout });
  }

  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    return this.transport.on<CDPMessage>(event, (message) => handler((message.params ?? {}) as T));
  }

  once<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    return this.transport.once<CDPMessage>(event, (message) => handler((message.params ?? {}) as T));
  }

  off<T = unknown>(event: string, handler: EventHandler<T>): void {
    this.transport.off(event, handler as EventHandler<unknown>);
  }

  onAny(handler: WildcardEventHandler): () => void {
    return this.transport.onAny((event, payload) => {
      const message = payload as CDPMessage;
      handler(event, message.params ?? message);
    });
  }

  waitFor<T = unknown>(event: string, options: WaitForEventOptions<T> = {}): Promise<T> {
    const promise = new Promise<T>((resolve) => {
      const off = this.on<T>(event, (payload) => {
        if (options.predicate && !options.predicate(payload)) return;
        off();
        resolve(payload);
      });
    });
    return withTimeout(promise, { timeout: options.timeout, label: `Waiting for ${event}` });
  }

  onSession<T = unknown>(sessionId: string, event: string, handler: EventHandler<T>): () => void {
    return this.transport.on<CDPMessage>(`${sessionId}:${event}`, (message) => handler((message.params ?? {}) as T));
  }

  onceSession<T = unknown>(sessionId: string, event: string, handler: EventHandler<T>): () => void {
    return this.transport.once<CDPMessage>(`${sessionId}:${event}`, (message) => handler((message.params ?? {}) as T));
  }

  waitForSession<T = unknown>(sessionId: string, event: string, options: WaitForEventOptions<T> = {}): Promise<T> {
    const promise = new Promise<T>((resolve) => {
      const off = this.onSession<T>(sessionId, event, (payload) => {
        if (options.predicate && !options.predicate(payload)) return;
        off();
        resolve(payload);
      });
    });
    return withTimeout(promise, { timeout: options.timeout, label: `Waiting for ${event}`, sessionId });
  }

  async createTarget(url = "about:blank"): Promise<string> {
    const result = await this.send<{ targetId: string }>("Target.createTarget", { url });
    return result.targetId;
  }

  async attachToTarget(targetId: string): Promise<CDPSession> {
    const result = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const session = new CDPSession(this, result.sessionId, targetId);
    this.sessions.set(result.sessionId, session);
    return session;
  }

  async newSession(url = "about:blank"): Promise<CDPSession> {
    const targetId = await this.createTarget(url);
    return this.attachToTarget(targetId);
  }

  async detachSession(sessionId: string): Promise<void> {
    await this.send("Target.detachFromTarget", { sessionId });
    this.sessions.delete(sessionId);
  }

  async closeTarget(targetId: string): Promise<void> {
    await this.send("Target.closeTarget", { targetId });
  }

  close(): void {
    this.transport.close();
    this.sessions.clear();
  }
}
