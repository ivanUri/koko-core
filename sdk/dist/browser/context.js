export class BrowserContext {
    browser;
    _pages = new Set();
    initScripts = [];
    viewport;
    constructor(browser, options = {}) {
        this.browser = browser;
        this.viewport = options.viewport;
    }
    async newPage(url = "about:blank") {
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
    async cookies(urls) {
        const page = await this.ensurePage();
        const result = await page.session.send(urls?.length ? "Network.getCookies" : "Network.getAllCookies", urls?.length ? { urls } : undefined);
        return result.cookies ?? [];
    }
    async addCookies(cookies) {
        if (!cookies.length)
            return;
        const page = await this.ensurePage();
        await page.session.send("Network.setCookies", { cookies });
    }
    async clearCookies() {
        const page = await this.ensurePage();
        const all = await page.session.send("Network.getAllCookies");
        for (const cookie of all.cookies ?? []) {
            await page.session.send("Network.deleteCookies", {
                name: cookie.name,
                domain: cookie.domain,
                path: cookie.path,
            }).catch(() => undefined);
        }
    }
    async addInitScript(source) {
        const script = typeof source === "function" ? `(${source.toString()})();` : source;
        this.initScripts.push(script);
        await Promise.all([...this._pages].map((page) => page.addInitScript(script)));
    }
    async setViewportSize(size) {
        this.viewport = size;
        await Promise.all([...this._pages].map((page) => page.setViewportSize(size)));
    }
    pages() {
        return [...this._pages];
    }
    async close() {
        await Promise.all([...this._pages].map((page) => page.close().catch(() => undefined)));
        this._pages.clear();
        this.browser.releaseContext(this);
    }
    async ensurePage() {
        const existing = this._pages.values().next().value;
        if (existing)
            return existing;
        return this.newPage();
    }
}
//# sourceMappingURL=context.js.map