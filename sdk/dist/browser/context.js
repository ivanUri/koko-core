export class BrowserContext {
    browser;
    constructor(browser) {
        this.browser = browser;
    }
    newPage() {
        return this.browser.newPage();
    }
    async close() {
        // Placeholder for future isolated context support once Velora exposes it via CDP.
    }
}
//# sourceMappingURL=context.js.map