import type { Browser } from "./browser.js";
import type { Page } from "./page.js";
export declare class BrowserContext {
    private readonly browser;
    private readonly pages;
    constructor(browser: Browser);
    newPage(url?: string): Promise<Page>;
    close(): Promise<void>;
}
