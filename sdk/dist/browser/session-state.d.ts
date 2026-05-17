import type { Page } from "./page.js";
export interface CookieState {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "Strict" | "Lax" | "None" | string;
    url?: string;
}
export interface BrowserSessionState {
    version: 1;
    origin?: string;
    savedAt: string;
    cookies: CookieState[];
    localStorage: Record<string, string>;
    sessionStorage: Record<string, string>;
}
export declare function captureSessionState(page: Page, origin?: string): Promise<BrowserSessionState>;
export declare function restoreSessionState(page: Page, state: BrowserSessionState): Promise<void>;
