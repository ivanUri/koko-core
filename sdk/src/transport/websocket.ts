import WebSocket from "ws";
import { EventBus, type EventHandler, type WildcardEventHandler } from "../cdp/events.js";
import { ProtocolError, WebSocketClosedError } from "../cdp/errors.js";
import { Logger, type LoggerOption } from "../utils/logger.js";

export interface CDPMessage {
  id?: number;
  method?: string;
  params?: unknown;
  sessionId?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface TransportSendOptions {
  timeout?: number;
  sessionId?: string;
}

interface PendingRequest {
  method: string;
  sessionId?: string;
  payload: unknown;
  timer: NodeJS.Timeout;
  resolve(value: unknown): void;
  reject(reason?: unknown): void;
}

export interface WebSocketTransportOptions {
  defaultTimeout?: number;
  logger?: LoggerOption;
}

export class WebSocketTransport {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly events = new EventBus();
  private readonly defaultTimeout: number;
  private readonly logger?: ReturnType<Logger["child"]>;
  private closed = false;

  private constructor(private readonly socket: WebSocket, options: WebSocketTransportOptions = {}) {
    this.defaultTimeout = options.defaultTimeout ?? 30_000;
    this.logger = Logger.from(options.logger)?.child("transport");
    this.bindSocket();
  }

  static async connect(endpoint: string, options: WebSocketTransportOptions = {}): Promise<WebSocketTransport> {
    const wsEndpoint = await resolveWebSocketEndpoint(endpoint);
    const socket = new WebSocket(wsEndpoint);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new WebSocketTransport(socket, options);
  }

  send<T = unknown>(method: string, params?: unknown, options: TransportSendOptions = {}): Promise<T> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new WebSocketClosedError("WebSocket is not open", { method, sessionId: options.sessionId }));
    }

    const id = this.nextId++;
    const payload: CDPMessage = { id, method };
    if (params !== undefined) payload.params = params;
    if (options.sessionId) payload.sessionId = options.sessionId;

    this.logger?.log("send", payload);
    this.socket.send(JSON.stringify(payload));

    return new Promise<T>((resolve, reject) => {
      const timeout = options.timeout ?? this.defaultTimeout;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ProtocolError(`CDP command timed out: ${method}`, {
          method,
          sessionId: options.sessionId,
          timeout,
          payload,
        }));
      }, timeout);

      this.pending.set(id, {
        method,
        sessionId: options.sessionId,
        payload,
        timer,
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
  }

  on<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    return this.events.on(event, handler);
  }

  once<T = unknown>(event: string, handler: EventHandler<T>): () => void {
    return this.events.once(event, handler);
  }

  onAny(handler: WildcardEventHandler): () => void {
    return this.events.onAny(handler);
  }

  off<T = unknown>(event: string, handler: EventHandler<T>): void {
    this.events.off(event, handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close();
    this.rejectAll(new WebSocketClosedError("WebSocket closed"));
    this.events.removeAll();
  }

  private bindSocket(): void {
    this.socket.on("message", (data) => this.handleMessage(data.toString()));
    this.socket.on("close", () => {
      this.closed = true;
      this.rejectAll(new WebSocketClosedError("WebSocket closed"));
      this.events.emit("__close", {});
    });
    this.socket.on("error", (error) => {
      this.rejectAll(new WebSocketClosedError(error.message));
      this.events.emit("__error", error);
    });
  }

  private handleMessage(raw: string): void {
    let message: CDPMessage;
    try {
      message = JSON.parse(raw) as CDPMessage;
    } catch (error) {
      this.events.emit("__parseError", { raw, error });
      return;
    }

    this.logger?.log("recv", message);

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new ProtocolError(message.error.message, {
          method: pending.method,
          sessionId: pending.sessionId,
          payload: message,
        }));
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method) {
      this.events.emit(message.method, message);
      if (message.sessionId) this.events.emit(`${message.sessionId}:${message.method}`, message);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

async function resolveWebSocketEndpoint(endpoint: string): Promise<string> {
  if (endpoint.startsWith("ws://") || endpoint.startsWith("wss://")) return endpoint;
  const base = endpoint.replace(/\/$/, "");
  const res = await fetch(`${base}/json/version`);
  if (!res.ok) throw new Error(`Unable to resolve CDP endpoint: ${res.status} ${res.statusText}`);
  const json = await res.json() as { webSocketDebuggerUrl?: string };
  if (!json.webSocketDebuggerUrl) throw new Error("CDP /json/version did not include webSocketDebuggerUrl");
  return json.webSocketDebuggerUrl;
}
