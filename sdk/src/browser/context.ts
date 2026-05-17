import type { Browser } from "./browser.js";
import type { Page } from "./page.js";

export class BrowserContext {
  constructor(private readonly browser: Browser) {}

  newPage(): Promise<Page> {
    return this.browser.newPage();
  }

  async close(): Promise<void> {
    // Placeholder for future isolated context support once Velora exposes it via CDP.
  }
}
