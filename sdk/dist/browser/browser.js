import { CDPClient } from "../cdp/client.js";
import { BrowserContext } from "./context.js";
import { Page } from "./page.js";
export class Browser {
    client;
    pages = new Set();
    constructor(client) {
        this.client = client;
    }
    static async connect(endpoint, options = {}) {
        return new Browser(await CDPClient.connect(endpoint, options));
    }
    async newSession(url = "about:blank") {
        return this.client.newSession(url);
    }
    async newPage(url = "about:blank") {
        const session = await this.client.newSession(url);
        const page = new Page(session);
        await page.init();
        this.pages.add(page);
        return page;
    }
    newContext() {
        return new BrowserContext(this);
    }
    async close() {
        await Promise.all([...this.pages].map((page) => page.close().catch(() => undefined)));
        this.pages.clear();
        this.client.close();
    }
}
//# sourceMappingURL=browser.js.map