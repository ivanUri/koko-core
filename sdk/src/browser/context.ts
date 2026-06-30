import type { Browser } from "./browser.js";
import type { Page } from "./page.js";
import type { CookieState } from "./session-state.js";
import type { ViewportSize } from "./page.js";

export interface BrowserContextOptions {
  viewport?: ViewportSize;
}

export class BrowserContext {
  private readonly _pages = new Set<Page>();
  private readonly initScripts: string[] = [];
  private viewport?: ViewportSize;

  constructor(
    private readonly browser: Browser,
    options: BrowserContextOptions = {},
  ) {
    this.viewport = options.viewport;
  }

  async newPage(url = "about:blank"): Promise<Page> {
    const page = await this.browser.newPage(url);
    this._pages.add(page);
    page.onClose(() => this._pages.delete(page));
    for (const script of this.initScripts) {
      await page.addInitScript(script);
    }
    if (this.viewport) {
      await page.setViewportSize(this.viewport);
    }
    return page;
  }

  async cookies(urls?: string[]): Promise<CookieState[]> {
    const page = await this.ensurePage();
    const result = await page.session.send<{ cookies: CookieState[] }>(
      urls?.length ? "Network.getCookies" : "Network.getAllCookies",
      urls?.length ? { urls } : undefined,
    );
    return result.cookies ?? [];
  }

  async addCookies(cookies: CookieState[]): Promise<void> {
    if (!cookies.length) return;
    const page = await this.ensurePage();
    await page.session.send("Network.setCookies", { cookies });
  }

  async clearCookies(): Promise<void> {
    const page = await this.ensurePage();
    const all = await page.session.send<{ cookies: CookieState[] }>("Network.getAllCookies");
    for (const cookie of all.cookies ?? []) {
      await page.session.send("Network.deleteCookies", {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
      }).catch(() => undefined);
    }
  }

  async addInitScript(source: string | Function): Promise<void> {
    const script = typeof source === "function" ? `(${source.toString()})();` : source;
    this.initScripts.push(script);
    await Promise.all([...this._pages].map((page) => page.addInitScript(script)));
  }

  async setViewportSize(size: ViewportSize): Promise<void> {
    this.viewport = size;
    await Promise.all([...this._pages].map((page) => page.setViewportSize(size)));
  }

  pages(): Page[] {
    return [...this._pages];
  }

  async close(): Promise<void> {
    await Promise.all([...this._pages].map((page) => page.close().catch(() => undefined)));
    this._pages.clear();
    this.browser.releaseContext(this);
  }

  private async ensurePage(): Promise<Page> {
    const existing = this._pages.values().next().value as Page | undefined;
    if (existing) return existing;
    return this.newPage();
  }
}