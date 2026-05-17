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

export async function captureSessionState(page: Page, origin?: string): Promise<BrowserSessionState> {
    await page.init();
    const cookieResult = await page.session.send<{ cookies?: CookieState[] }>("Network.getAllCookies").catch(() => ({ cookies: [] }));
    const storage = await page.evaluate<{ localStorage: Record<string, string>; sessionStorage: Record<string, string> }>(
        "({ localStorage: Object.fromEntries(Object.entries(localStorage)), sessionStorage: Object.fromEntries(Object.entries(sessionStorage)) })",
    ).catch(() => ({ localStorage: {}, sessionStorage: {} }));

    return {
        version: 1,
        origin,
        savedAt: new Date().toISOString(),
        cookies: normalizeCookies(cookieResult.cookies ?? []),
        localStorage: storage.localStorage ?? {},
        sessionStorage: storage.sessionStorage ?? {},
    };
}

export async function restoreSessionState(page: Page, state: BrowserSessionState): Promise<void> {
    await page.init();
    if (state.cookies?.length) {
        await page.session.send("Network.setCookies", { cookies: normalizeCookies(state.cookies) });
    }

    if (!state.origin) return;
    await page.goto(state.origin, { waitUntil: "load" }).catch(() => undefined);
    await page.evaluate(
        `((state) => {
      for (const [key, value] of Object.entries(state.localStorage || {})) localStorage.setItem(key, String(value));
      for (const [key, value] of Object.entries(state.sessionStorage || {})) sessionStorage.setItem(key, String(value));
    })(${JSON.stringify({ localStorage: state.localStorage ?? {}, sessionStorage: state.sessionStorage ?? {} })})`,
    );
}

function normalizeCookies(cookies: CookieState[]): CookieState[] {
    return cookies.map((cookie) => {
        const normalized: CookieState = { ...cookie };
        if (normalized.expires === -1) delete normalized.expires;
        return normalized;
    });
}