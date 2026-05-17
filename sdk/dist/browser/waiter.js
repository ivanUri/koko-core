import { TimeoutError } from "../cdp/errors.js";
import { delay, withTimeout } from "../utils/timeout.js";
export class PageWaiter {
    session;
    network;
    constructor(session, network) {
        this.session = session;
        this.network = network;
    }
    async waitForNavigation(options = {}) {
        const waitUntil = options.waitUntil ?? "load";
        if (waitUntil === "none" || waitUntil === "commit")
            return;
        if (waitUntil === "domcontentloaded") {
            await this.session.waitFor("Page.domContentEventFired", { timeout: options.timeout });
            return;
        }
        if (waitUntil === "load") {
            await this.session.waitFor("Page.loadEventFired", { timeout: options.timeout });
            return;
        }
        await this.network.waitForIdle({ idleMs: options.networkIdleMs, timeout: options.timeout });
    }
    async waitForSelector(selector, options = {}) {
        const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      if (${options.visible ? "true" : "false"}) {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style && style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      }
      return true;
    })()`;
        await this.pollExpression(expression, options.timeout, `Waiting for selector ${selector}`);
    }
    async waitForFunction(fn, options = {}) {
        const source = typeof fn === "function" ? `(${fn.toString()})()` : `(${fn})`;
        await this.pollExpression(source, options.timeout, "Waiting for function", options.pollingMs);
    }
    async pollExpression(expression, timeout = 30_000, label, pollingMs = 100) {
        const started = Date.now();
        await withTimeout((async () => {
            while (true) {
                const result = await this.session.send("Runtime.evaluate", {
                    expression,
                    returnByValue: true,
                    awaitPromise: true,
                });
                if (result.exceptionDetails)
                    throw new TimeoutError(`${label} failed`, { payload: result.exceptionDetails });
                if (result.result?.value)
                    return;
                if (Date.now() - started > timeout)
                    throw new TimeoutError(label, { timeout });
                await delay(pollingMs);
            }
        })(), { timeout, label });
    }
}
//# sourceMappingURL=waiter.js.map