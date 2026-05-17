import type { Browser } from "./browser.js";
import type { Page } from "./page.js";
export declare class BrowserContext {
    private readonly browser;
    constructor(browser: Browser);
    newPage(): Promise<Page>;
    close(): Promise<void>;
}
