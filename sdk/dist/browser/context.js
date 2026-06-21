export class BrowserContext {
    browser;
    pages = new Set();
    constructor(browser) {
        this.browser = browser;
    }
    async newPage(url = "about:blank") {
        const page = await this.browser.newPage(url);
        this.pages.add(page);
        page.onClose(() => this.pages.delete(page));
        return page;
    }
    async close() {
        await Promise.all([...this.pages].map((page) => page.close().catch(() => undefined)));
        this.pages.clear();
    }
}
//# sourceMappingURL=context.js.map