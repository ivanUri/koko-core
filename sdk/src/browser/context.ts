import type { Browser } from "./browser.js";
import type { Page } from "./page.js";

export class BrowserContext {
  private readonly pages = new Set<Page>();

  constructor(private readonly browser: Browser) {}

  async newPage(url = "about:blank"): Promise<Page> {
    const page = await this.browser.newPage(url);
    this.pages.add(page);
    page.onClose(() => this.pages.delete(page));
    return page;
  }

  async close(): Promise<void> {
    await Promise.all([...this.pages].map((page) => page.close().catch(() => undefined)));
    this.pages.clear();
  }
}