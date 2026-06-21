import { Browser } from "./browser.js";
/** One Browser + Page per worker — matches multi-process crawl benchmark shape. */
export async function createCrawlWorker(options) {
    const browser = await Browser.connect(options.endpoint, options.connect);
    const page = await browser.newPage();
    const timeoutMs = options.timeoutMs ?? 45_000;
    const gotoOpts = {
        waitUntil: options.goto?.waitUntil ?? "domcontentloaded",
        timeout: options.goto?.timeout ?? timeoutMs,
        networkIdleMs: options.goto?.networkIdleMs,
    };
    const extractOpts = options.extract ?? {};
    return {
        async fetch(item) {
            const t0 = Date.now();
            try {
                await page.goto(item.url, gotoOpts);
                const domReadyMs = Date.now() - t0;
                const ttf0 = Date.now();
                const data = await page.extract({ ...extractOpts, timeout: timeoutMs });
                const ttfexMs = Date.now() - t0;
                const extractMs = Date.now() - ttf0;
                const totalMs = Date.now() - t0;
                return {
                    ok: true,
                    idx: item.i,
                    title: item.title,
                    url: item.url,
                    ms: totalMs,
                    worker: 0,
                    domReadyMs,
                    ttfexMs,
                    extractMs,
                    totalMs,
                    ...data,
                };
            }
            catch (err) {
                return {
                    ok: false,
                    idx: item.i,
                    title: item.title,
                    url: item.url,
                    ms: Date.now() - t0,
                    worker: 0,
                    error: err instanceof Error ? err.message : String(err),
                };
            }
        },
        async close() {
            await browser.close();
        },
    };
}
//# sourceMappingURL=crawl.js.map