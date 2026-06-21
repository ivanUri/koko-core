import type { CDPSession } from "../cdp/session.js";
import { withTimeout } from "../utils/timeout.js";

type IdleListener = () => void;

export interface NetworkRequest {
  requestId: string;
  url: string;
  method?: string;
  timestamp?: number;
  redirectChain: string[];
  response?: NetworkResponse;
  failureText?: string;
}

export interface NetworkResponse {
  url: string;
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
}

const DEFAULT_MAX_REQUESTS = 2048;

export class NetworkTracker {
  readonly requests = new Map<string, NetworkRequest>();
  readonly inflight = new Set<string>();
  private cleanup: Array<() => void> = [];
  private readonly listeners = new Set<IdleListener>();
  private maxRequests = DEFAULT_MAX_REQUESTS;

  constructor(private readonly session: CDPSession) {}

  setMaxRequests(max: number): void {
    this.maxRequests = Math.max(64, max);
    this.pruneCompleted();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  async enable(): Promise<void> {
    this.cleanup.push(
      this.session.on<any>("Network.requestWillBeSent", (event) => this.onRequest(event)),
      this.session.on<any>("Network.responseReceived", (event) => this.onResponse(event)),
      this.session.on<any>("Network.loadingFinished", (event) => this.onDone(event.requestId)),
      this.session.on<any>("Network.loadingFailed", (event) => this.onFailed(event)),
    );
    await this.session.send("Network.enable").catch(() => undefined);
  }

  dispose(): void {
    for (const off of this.cleanup) off();
    this.cleanup = [];
    this.reset();
  }

  /** Clear tracked requests (e.g. at navigation start). */
  reset(): void {
    this.requests.clear();
    this.inflight.clear();
  }

  waitForIdle(options: { idleMs?: number; timeout?: number } = {}): Promise<void> {
    const idleMs = options.idleMs ?? 500;
    const promise = new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        this.listeners.delete(listener);
        if (timer) clearTimeout(timer);
        resolve();
      };
      const listener: IdleListener = () => {
        if (this.inflight.size === 0) {
          if (!timer) timer = setTimeout(finish, idleMs);
        } else if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
      this.listeners.add(listener);
      listener();
    });
    return withTimeout(promise, { timeout: options.timeout, label: "Waiting for network idle" });
  }

  private onRequest(event: any): void {
    const previous = this.requests.get(event.requestId);
    const redirectChain = previous ? [...previous.redirectChain, previous.url] : [];
    this.requests.set(event.requestId, {
      requestId: event.requestId,
      url: event.request?.url ?? "",
      method: event.request?.method,
      timestamp: event.timestamp,
      redirectChain,
    });
    this.inflight.add(event.requestId);
    this.pruneCompleted();
    this.notify();
  }

  private onResponse(event: any): void {
    const request = this.requests.get(event.requestId);
    if (!request) return;
    request.response = {
      url: event.response?.url ?? request.url,
      status: event.response?.status ?? 0,
      statusText: event.response?.statusText,
      headers: event.response?.headers,
    };
  }

  private onDone(requestId: string): void {
    this.inflight.delete(requestId);
    this.pruneCompleted();
    this.notify();
  }

  private onFailed(event: any): void {
    const request = this.requests.get(event.requestId);
    if (request) request.failureText = event.errorText;
    this.inflight.delete(event.requestId);
    this.pruneCompleted();
    this.notify();
  }

  private pruneCompleted(): void {
    if (this.requests.size <= this.maxRequests) return;
    for (const [id, req] of this.requests) {
      if (this.inflight.has(id)) continue;
      this.requests.delete(id);
      if (this.requests.size <= this.maxRequests) break;
    }
  }
}