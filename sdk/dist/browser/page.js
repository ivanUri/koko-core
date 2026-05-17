import { NavigationError } from "../cdp/errors.js";
import { PageWaiter } from "./waiter.js";
import { NetworkTracker } from "./network.js";
export class Page {
    session;
    network;
    waiter;
    initialized = false;
    constructor(session) {
        this.session = session;
        this.network = new NetworkTracker(session);
        this.waiter = new PageWaiter(session, this.network);
    }
    async init() {
        if (this.initialized)
            return;
        await this.session.send("Page.enable").catch(() => undefined);
        await this.session.send("Runtime.enable").catch(() => undefined);
        await this.network.enable();
        this.initialized = true;
    }
    async goto(url, options = {}) {
        await this.init();
        const waitPromise = this.waiter.waitForNavigation(options);
        const result = await this.session.send("Page.navigate", { url }, options.timeout);
        if (result.errorText)
            throw new NavigationError(result.errorText, { method: "Page.navigate", sessionId: this.session.sessionId, payload: result });
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
            throw new NavigationError("Runtime.evaluate failed", {
                method: "Runtime.evaluate",
                sessionId: this.session.sessionId,
                payload: result.exceptionDetails,
            });
        }
        return result.result?.value;
    }
    async content() {
        await this.init();
        const domHtml = await this.contentFromDOM().catch(() => undefined);
        if (domHtml)
            return domHtml;
        const html = await this.evaluate("document.documentElement ? document.documentElement.outerHTML : ''");
        const doctype = await this.evaluate("document.doctype ? new XMLSerializer().serializeToString(document.doctype) : ''").catch(() => "");
        return withDoctype(html, doctype);
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
    }
    async contentFromDOM() {
        const { root } = await this.session.send("DOM.getDocument", { depth: 0 });
        if (!root?.nodeId)
            return undefined;
        const result = await this.session.send("DOM.getOuterHTML", { nodeId: root.nodeId });
        const html = result.outerHTML;
        if (!html)
            return undefined;
        const doctype = await this.evaluate("document.doctype ? new XMLSerializer().serializeToString(document.doctype) : ''").catch(() => "");
        return withDoctype(html, doctype);
    }
}
function withDoctype(html = "", doctype = "") {
    if (/^\s*<!doctype\s+/i.test(html))
        return html;
    return `${doctype || "<!DOCTYPE html>"}\n${html}`;
}
//# sourceMappingURL=page.js.map