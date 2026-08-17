export class PlaywrightAdapter {
  static id = "playwright-chromium";
  static label = "Playwright Chromium";

  constructor(options) {
    this.options = options;
    this.id = PlaywrightAdapter.id;
    this.label = PlaywrightAdapter.label;
    this.server = null;
    this.browser = null;
    this.launchMetrics = null;
  }

  get pid() {
    return this.server?.process()?.pid;
  }

  async launch() {
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      throw new Error("Playwright baseline unavailable; run `npm install` in koko-core");
    }
    const started = performance.now();
    this.server = await chromium.launchServer({
      executablePath: this.options.chromeBin,
      headless: true,
      args: [
        "--no-first-run",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--metrics-recording-only",
      ],
    });
    this.browser = await chromium.connect(this.server.wsEndpoint());
    this.browserVersion = this.browser.version();
    this.launchMetrics = { processReadyMs: performance.now() - started };
    return this;
  }

  async newSession() {
    const started = performance.now();
    const contextStarted = performance.now();
    const context = await this.browser.newContext();
    const contextReady = performance.now();
    const page = await context.newPage();
    const ready = performance.now();
    let closed = false;
    return {
      timings: {
        durationMs: ready - started,
        contextMs: contextReady - contextStarted,
        targetMs: ready - contextReady,
        attachMs: 0,
        domainsMs: 0,
      },
      async navigate(url, { waitUntil = "domcontentloaded", timeoutMs = 30_000 } = {}) {
        const navigationStarted = performance.now();
        const response = await page.goto(url, { waitUntil, timeout: timeoutMs });
        const durationMs = performance.now() - navigationStarted;
        return {
          durationMs,
          navigationAckMs: durationMs,
          httpStatus: response?.status() ?? null,
          responseCount: await page.evaluate(() => performance.getEntriesByType("resource").length + 1),
          responseUrl: response?.url() ?? null,
        };
      },
      evaluate(expression) {
        return page.evaluate(expression);
      },
      async close() {
        if (closed) return;
        closed = true;
        await context.close();
      },
    };
  }

  async close() {
    await this.browser?.close();
    await this.server?.close();
    this.browser = null;
    this.server = null;
  }
}
