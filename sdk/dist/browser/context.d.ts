import type { Browser } from "./browser.js";
import type { Page } from "./page.js";
import type { CookieState } from "./session-state.js";
import type { ViewportSize } from "./page.js";
export interface BrowserContextOptions {
    viewport?: ViewportSize;
}
export declare class BrowserContext {
    private readonly browser;
    private readonly _pages;
    private readonly initScripts;
    private viewport?;
    constructor(browser: Browser, options?: BrowserContextOptions);
    newPage(url?: string): Promise<Page>;
    cookies(urls?: string[]): Promise<CookieState[]>;
    addCookies(cookies: CookieState[]): Promise<void>;
    clearCookies(): Promise<void>;
    addInitScript(source: string | Function): Promise<void>;
    setViewportSize(size: ViewportSize): Promise<void>;
    pages(): Page[];
    close(): Promise<void>;
    private ensurePage;
}
