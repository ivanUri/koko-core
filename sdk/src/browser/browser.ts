import { CDPClient } from "../cdp/client.js";
import type { WebSocketTransportOptions } from "../transport/websocket.js";
import { BrowserContext } from "./context.js";
import { Page } from "./page.js";

export class Browser {
  private readonly pages = new Set<Page>();

  private constructor(readonly client: CDPClient) {}

  static async connect(endpoint: string, options: WebSocketTransportOptions = {}): Promise<Browser> {
    return new Browser(await CDPClient.connect(endpoint, options));
  }

  async newSession(url = "about:blank") {
    return this.client.newSession(url);
  }

  async newPage(url = "about:blank"): Promise<Page> {
    const session = await this.client.newSession(url);
    const page = new Page(session);
    await page.init();
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
