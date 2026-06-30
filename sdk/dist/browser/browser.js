import { CDPClient } from "../cdp/client.js";
import { BrowserContext } from "./context.js";
import { Page } from "./page.js";
import { launchVelora } from "./launch.js";
export class Browser {
    client;
    pages = new Set();
    _contexts = new Set();
    constructor(client) {
        this.client = client;
    }
    static async connect(endpoint, options = {}) {
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
    static async launch(options = {}) {
        return launchVelora(options);
    }
    async newSession(url = "about:blank") {
        return this.client.newSession(url);
    }
    async newPage(url = "about:blank") {
        const session = await this.client.newSession(url);
        const page = new Page(session);
        page.onClose(() => this.pages.delete(page));
        await page.init();
        if (url !== "about:blank")
            await page.goto(url);
        this.pages.add(page);
        return page;
    }
    newContext(options = {}) {
        const context = new BrowserContext(this, options);
        this._contexts.add(context);
        return context;
    }
    contexts() {
        return [...this._contexts];
    }
    releaseContext(context) {
        this._contexts.delete(context);
    }
    async close() {
        await Promise.all([...this._contexts].map((ctx) => ctx.close().catch(() => undefined)));
        this._contexts.clear();
        await Promise.all([...this.pages].map((page) => page.close().catch(() => undefined)));
        this.pages.clear();
        this.client.close();
    }
}
//# sourceMappingURL=browser.js.map