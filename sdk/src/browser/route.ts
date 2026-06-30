import type { CDPSession } from "../cdp/session.js";

export interface RouteRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
}

export interface RouteFulfillOptions {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
  contentType?: string;
}

export class Route {
  private handled = false;

  constructor(
    private readonly session: CDPSession,
    readonly requestId: string,
    readonly request: RouteRequest,
  ) {}

  async continue(options: { headers?: Record<string, string>; postData?: string; url?: string } = {}): Promise<void> {
    this.ensureOnce();
    const headers = options.headers
      ? Object.entries(options.headers).map(([name, value]) => ({ name, value }))
      : undefined;
    await this.session.send("Fetch.continueRequest", {
      requestId: this.requestId,
      url: options.url,
      postData: options.postData,
      headers,
    });
  }

  async abort(errorReason: "Aborted" | "BlockedByClient" = "Aborted"): Promise<void> {
    this.ensureOnce();
    await this.session.send("Fetch.failRequest", { requestId: this.requestId, errorReason });
  }

  async fulfill(options: RouteFulfillOptions = {}): Promise<void> {
    this.ensureOnce();
    const headers = options.headers
      ? Object.entries(options.headers).map(([name, value]) => ({ name, value }))
      : options.contentType
        ? [{ name: "Content-Type", value: options.contentType }]
        : undefined;
    const body = options.body == null
      ? undefined
      : typeof options.body === "string"
        ? Buffer.from(options.body).toString("base64")
        : options.body.toString("base64");
    await this.session.send("Fetch.fulfillRequest", {
      requestId: this.requestId,
      responseCode: options.status ?? 200,
      responseHeaders: headers,
      body,
    });
  }

  private ensureOnce(): void {
    if (this.handled) throw new Error("Route already handled");
    this.handled = true;
  }
}

export type RouteHandler = (route: Route) => void | Promise<void>;

export type RoutePattern = string | RegExp | ((url: string) => boolean);

export function matchesRoutePattern(url: string, pattern: RoutePattern): boolean {
  if (typeof pattern === "string") return url.includes(pattern) || pattern === "*";
  if (pattern instanceof RegExp) return pattern.test(url);
  return pattern(url);
}

export class RouteRegistry {
  private fetchEnabled = false;
  private readonly handlers: Array<{ pattern: RoutePattern; handler: RouteHandler }> = [];
  private unsubscribe?: () => void;

  constructor(private readonly session: CDPSession) {}

  async route(pattern: RoutePattern, handler: RouteHandler): Promise<void> {
    this.handlers.push({ pattern, handler });
    await this.ensureFetchEnabled();
  }

  async unroute(pattern?: RoutePattern, handler?: RouteHandler): Promise<void> {
    if (pattern == null && handler == null) {
      this.handlers.length = 0;
      return;
    }
    for (let i = this.handlers.length - 1; i >= 0; i--) {
      const entry = this.handlers[i];
      if (pattern != null && entry.pattern !== pattern) continue;
      if (handler != null && entry.handler !== handler) continue;
      this.handlers.splice(i, 1);
    }
    if (this.handlers.length === 0) {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      await this.session.send("Fetch.disable").catch(() => undefined);
      this.fetchEnabled = false;
    }
  }

  dispose(): void {
    this.handlers.length = 0;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.fetchEnabled = false;
  }

  private async ensureFetchEnabled(): Promise<void> {
    if (this.fetchEnabled) return;
    this.unsubscribe = this.session.on<any>("Fetch.requestPaused", (event) => {
      void this.onRequestPaused(event);
    });
    await this.session.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    this.fetchEnabled = true;
  }

  private async onRequestPaused(event: any): Promise<void> {
    const url: string = event?.request?.url ?? "";
    const requestId: string = event?.requestId;
    if (!requestId) return;

    for (const { pattern, handler } of this.handlers) {
      if (!matchesRoutePattern(url, pattern)) continue;
      const headers: Record<string, string> = {};
      const raw = event?.request?.headers ?? {};
      for (const [name, value] of Object.entries(raw)) {
        if (typeof value === "string") headers[name] = value;
      }
      const route = new Route(this.session, requestId, {
        url,
        method: event?.request?.method ?? "GET",
        headers,
        postData: event?.request?.postData,
      });
      try {
        await handler(route);
      } catch {
        await route.continue().catch(() => undefined);
      }
      return;
    }

    await this.session.send("Fetch.continueRequest", { requestId }).catch(() => undefined);
  }
}