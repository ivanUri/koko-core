import { CDPClient } from "../cdp/client.js";
import type { WebSocketTransportOptions } from "../transport/websocket.js";
import { BrowserContext, type BrowserContextOptions } from "./context.js";
import { Page } from "./page.js";
import { launchVelora, type LaunchedVelora, type VeloraLaunchOptions } from "./launch.js";

export interface BrowserConnectOptions extends WebSocketTransportOptions {
  /** Enable Target.setDiscoverTargets + setAutoAttach (default: true). */
  enableTargetTracking?: boolean;
}

export class Browser {
  private readonly pages = new Set<Page>();
  private readonly _contexts = new Set<BrowserContext>();

  private constructor(readonly client: CDPClient) {}

  static async connect(endpoint: string, options: BrowserConnectOptions = {}): Promise<Browser> {
    const client = await CDPClient.connect(endpoint, options);
    if (options.enableTargetTracking !== false) {
      await client.enableTargetTracking();
    }
    return new Browser(client);
  }

  /**
   * Spawn a Velora server with antidetect profile/cookies and connect over CDP.
   * Requires `zig-out/bin/velora` (run `zig build` first).
   */
  static async launch(options: VeloraLaunchOptions = {}): Promise<LaunchedVelora> {
    return launchVelora(options);
  }

  async newSession(url = "about:blank") {
    return this.client.newSession(url);
  }

  async newPage(url = "about:blank"): Promise<Page> {
    const session = await this.client.newSession(url);
    const page = new Page(session);
    page.onClose(() => this.pages.delete(page));
    await page.init();
    if (url !== "about:blank") await page.goto(url);
    this.pages.add(page);
    return page;
  }

  newContext(options: BrowserContextOptions = {}): BrowserContext {
    const context = new BrowserContext(this, options);
    this._contexts.add(context);
    return context;
  }

  contexts(): BrowserContext[] {
    return [...this._contexts];
  }

  releaseContext(context: BrowserContext): void {
    this._contexts.delete(context);
  }

  async close(): Promise<void> {
    await Promise.all([...this._contexts].map((ctx) => ctx.close().catch(() => undefined)));
    this._contexts.clear();
    await Promise.all([...this.pages].map((page) => page.close().catch(() => undefined)));
    this.pages.clear();
    this.client.close();
  }
}