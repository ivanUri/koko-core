import { WebSocketTransport, type CDPMessage, type WebSocketTransportOptions } from "../transport/websocket.js";
import { withTimeout } from "../utils/timeout.js";
import { TargetClosedError, WebSocketClosedError } from "./errors.js";
import type { EventHandler, WildcardEventHandler } from "./events.js";
import { CDPSession } from "./session.js";

export interface WaitForEventOptions<T> {
  timeout?: number;
  predicate?: (payload: T) => boolean;
}

export class CDPClient {
  readonly sessions = new Map<string, CDPSession>();
  private targetTrackingStarted = false;

  private constructor(readonly transport: WebSocketTransport) {
    this.bindLifecycle();
  }

  static async connect(endpoint: string, options: WebSocketTransportOptions = {}): Promise<CDPClient> {
    return new CDPClient(await WebSocketTransport.connect(endpoint, options));
  }

  private bindLifecycle(): void {
    this.transport.on<CDPMessage>("Target.attachedToTarget", (message) => {
      const params = (message.params ?? {}) as { sessionId?: string; targetInfo?: { targetId?: string } };
      if (!params.sessionId) return;
      if (!this.sessions.has(params.sessionId)) {
        this.sessions.set(params.sessionId, new CDPSession(this, params.sessionId, params.targetInfo?.targetId));
      }
    });
    this.transport.on<CDPMessage>("Target.detachedFromTarget", (message) => {
      const params = (message.params ?? {}) as { sessionId?: string };
      if (!params.sessionId) return;
      const session = this.sessions.get(params.sessionId);
      if (session) session.markClosed(new TargetClosedError("Target detached", { sessionId: params.sessionId }));
      this.sessions.delete(params.sessionId);
    });
    this.transport.on("__close", () => {
      const error = new WebSocketClosedError("Transport closed");
      for (const session of this.sessions.values()) session.markClosed(error);
      this.sessions.clear();
    });
  }

  /** Enable global Target.* tracking (discover + auto-attach flatten). Call once after connect. */
  async enableTargetTracking(options: { autoAttach?: boolean; discover?: boolean } = {}): Promise<void> {
    if (this.targetTrackingStarted) return;
    this.targetTrackingStarted = true;
    if (options.discover ?? true) {
      await this.send("Target.setDiscoverTargets", { discover: true }).catch(() => undefined);
    }
    if (options.autoAttach ?? true) {
      await this.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined);
    }
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
    let session = this.sessions.get(result.sessionId);
    if (!session) {
      session = new CDPSession(this, result.sessionId, targetId);
      this.sessions.set(result.sessionId, session);
    }
    return session;
  }

  async newSession(url = "about:blank"): Promise<CDPSession> {
    const targetId = await this.createTarget(url);
    return this.attachToTarget(targetId);
  }

  async detachSession(sessionId: string): Promise<void> {
    try {
      await this.send("Target.detachFromTarget", { sessionId });
    } finally {
      const session = this.sessions.get(sessionId);
      if (session) session.markClosed(new TargetClosedError("Session detached", { sessionId }));
      this.sessions.delete(sessionId);
    }
  }

  async closeTarget(targetId: string): Promise<void> {
    await this.send("Target.closeTarget", { targetId });
  }

  close(): void {
    const error = new WebSocketClosedError("Client closed");
    for (const session of this.sessions.values()) session.markClosed(error);
    this.sessions.clear();
    this.transport.close();
  }
}
