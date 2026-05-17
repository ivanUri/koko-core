export async function captureSessionState(page, origin) {
    await page.init();
    const cookieResult = await page.session.send("Network.getAllCookies").catch(() => ({ cookies: [] }));
    const storage = await page.evaluate("({ localStorage: Object.fromEntries(Object.entries(localStorage)), sessionStorage: Object.fromEntries(Object.entries(sessionStorage)) })").catch(() => ({ localStorage: {}, sessionStorage: {} }));
    return {
        version: 1,
        origin,
        savedAt: new Date().toISOString(),
        cookies: normalizeCookies(cookieResult.cookies ?? []),
        localStorage: storage.localStorage ?? {},
        sessionStorage: storage.sessionStorage ?? {},
    };
}
export async function restoreSessionState(page, state) {
    await page.init();
    if (state.cookies?.length) {
        await page.session.send("Network.setCookies", { cookies: normalizeCookies(state.cookies) });
    }
    if (!state.origin)
        return;
    await page.goto(state.origin, { waitUntil: "load" }).catch(() => undefined);
    await page.evaluate(`((state) => {
      for (const [key, value] of Object.entries(state.localStorage || {})) localStorage.setItem(key, String(value));
      for (const [key, value] of Object.entries(state.sessionStorage || {})) sessionStorage.setItem(key, String(value));
    })(${JSON.stringify({ localStorage: state.localStorage ?? {}, sessionStorage: state.sessionStorage ?? {} })})`);
}
function normalizeCookies(cookies) {
    return cookies.map((cookie) => {
        const normalized = { ...cookie };
        if (normalized.expires === -1)
            delete normalized.expires;
        return normalized;
    });
}
//# sourceMappingURL=session-state.js.map