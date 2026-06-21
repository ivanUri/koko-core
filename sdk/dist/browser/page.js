import { NavigationError, ProtocolError, TargetClosedError } from "../cdp/errors.js";
import { PageWaiter } from "./waiter.js";
import { NetworkTracker } from "./network.js";
const DEFAULT_TTFX = `(() => {
  const el = document.querySelector("#firstHeading") || document.querySelector("h1");
  return el?.textContent?.trim() || null;
})()`;
const DEFAULT_EXTRACT = `(() => {
  const links = document.querySelectorAll('a[href^="/wiki/"]:not([href*=":"])');
  const title = document.querySelector("#firstHeading")?.textContent?.trim()
    || document.title.replace(/ - Wikipedia$/, "").trim();
  return {
    title,
    linkCount: links.length,
    htmlBytes: document.documentElement?.outerHTML?.length ?? 0,
  };
})()`;
const CONTENT_EXPR = `(() => {
  const html = document.documentElement ? document.documentElement.outerHTML : '';
  if (/^\\s*<!doctype/i.test(html)) return html;
  const dt = document.doctype ? new XMLSerializer().serializeToString(document.doctype) : '';
  return (dt || '<!DOCTYPE html>') + '\\n' + html;
})()`;
export class Page {
    session;
    network;
    waiter;
    initialized = false;
    mainFrameId;
    closeHooks = new Set();
    constructor(session) {
        this.session = session;
        this.network = new NetworkTracker(session);
        this.waiter = new PageWaiter(session, this.network);
    }
    /** Register cleanup when page.close() runs (used by Browser/Context). */
    onClose(hook) {
        this.closeHooks.add(hook);
    }
    async init() {
        if (this.initialized)
            return;
        this.initialized = true;
        this.session.on("Page.frameNavigated", (event) => {
            const frame = event?.frame;
            if (frame && !frame.parentId)
                this.mainFrameId = frame.id;
        });
        this.session.on("Inspector.detached", (event) => {
            this.session.markClosed(new TargetClosedError(event?.reason ?? "Inspector detached", { sessionId: this.session.sessionId }));
        });
        await this.session.send("Page.enable").catch(() => undefined);
        await this.session.send("Runtime.enable").catch(() => undefined);
        await this.network.enable();
        const tree = await this.session.send("Page.getFrameTree").catch(() => undefined);
        this.mainFrameId = tree?.frameTree?.frame?.id ?? this.mainFrameId;
    }
    async goto(url, options = {}) {
        await this.init();
        this.network.reset();
        const waitPromise = this.waiter.waitForNavigation(options);
        waitPromise.catch(() => undefined);
        const result = await this.session.send("Page.navigate", { url }, options.timeout);
        if (result.errorText) {
            throw new NavigationError(result.errorText, { method: "Page.navigate", sessionId: this.session.sessionId, payload: result });
        }
        if (result.frameId)
            this.mainFrameId = result.frameId;
        await waitPromise;
    }
    async evaluate(expressionOrFunction, options = {}) {
        await this.init();
        const expression = typeof expressionOrFunction === "function"
            ? `(${expressionOrFunction.toString()})()`
            : expressionOrFunction;
        const result = await this.session.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: true,
        }, options.timeout);
        if (result.exceptionDetails) {
            const ex = result.exceptionDetails;
            const desc = ex?.exception?.description ?? ex?.exception?.value ?? ex?.text ?? "Runtime.evaluate failed";
            throw new ProtocolError(typeof desc === "string" ? desc : JSON.stringify(desc), {
                method: "Runtime.evaluate",
                sessionId: this.session.sessionId,
                payload: ex,
            });
        }
        return result.result?.value;
    }
    /** Single round-trip HTML snapshot (doctype + outerHTML). */
    async content() {
        await this.init();
        return this.evaluate(CONTENT_EXPR);
    }
    /**
     * Crawler helper: wait for a TTFX probe then run a structured extract expression.
     * Defaults match the Wikipedia crawl benchmark.
     */
    async extract(options = {}) {
        await this.init();
        const timeout = options.timeout ?? 30_000;
        const ttfx = options.ttfx ?? DEFAULT_TTFX;
        const expression = options.expression ?? DEFAULT_EXTRACT;
        await this.waiter.pollUntilTruthy(ttfx, { timeout, label: "Waiting for extractable content" });
        const value = await this.evaluate(expression, { timeout });
        if (!value || typeof value !== "object") {
            throw new ProtocolError("extract returned invalid payload", { method: "Page.extract" });
        }
        return value;
    }
    waitForSelector(selector, options) {
        return this.waiter.waitForSelector(selector, options);
    }
    waitForFunction(fn, options) {
        return this.waiter.waitForFunction(fn, options);
    }
    async close() {
        this.network.dispose();
        if (this.session.targetId)
            await this.session.client.closeTarget(this.session.targetId).catch(() => undefined);
        await this.session.detach().catch(() => undefined);
        for (const hook of this.closeHooks)
            hook();
        this.closeHooks.clear();
    }
    get frameId() {
        return this.mainFrameId;
    }
}
//# sourceMappingURL=page.js.map