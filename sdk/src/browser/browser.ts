import { CDPClient } from "../cdp/client.js";
import type { WebSocketTransportOptions } from "../transport/websocket.js";
import { BrowserContext } from "./context.js";
import { Page } from "./page.js";

export interface BrowserConnectOptions extends WebSocketTransportOptions {
  /** Enable Target.setDiscoverTargets + setAutoAttach (default: true). */
  enableTargetTracking?: boolean;
}

export class Browser {
  private readonly pages = new Set<Page>();

  private constructor(readonly client: CDPClient) {}

  static async connect(endpoint: string, options: BrowserConnectOptions = {}): Promise<Browser> {
    const client = await CDPClient.connect(endpoint, options);
    if (options.enableTargetTracking !== false) {
      await client.enableTargetTracking();
    }
    return new Browser(client);
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

  newContext(): BrowserContext {
    return new BrowserContext(this);
  }

  async close(): Promise<void> {
    await Promise.all([...this.pages].map((page) => page.close().catch(() => undefined)));
    this.pages.clear();
    this.client.close();
  }
}