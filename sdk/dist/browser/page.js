import { NavigationError, ProtocolError, TargetClosedError } from "../cdp/errors.js";
import { delay } from "../utils/timeout.js";
import { PageWaiter } from "./waiter.js";
import { NetworkTracker } from "./network.js";
import { RouteRegistry } from "./route.js";
import { Locator } from "./locator.js";
import { LPClient } from "./lp-client.js";
import { NodeHandle } from "./node-handle.js";
import { searchGoogle } from "./google-search.js";
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
    /** Velora LP domain — AI extraction and backend-node agent actions. */
    agent;
    routes;
    initialized = false;
    mainFrameId;
    closeHooks = new Set();
    constructor(session) {
        this.session = session;
        this.routes = new RouteRegistry(session);
        this.network = new NetworkTracker(session);
        this.waiter = new PageWaiter(session, this.network);
        this.agent = new LPClient(this, session);
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
    waitForNavigation(options = {}) {
        return this.waiter.waitForNavigation(options);
    }
    waitForURL(url, options) {
        return this.waiter.waitForURL(url, options);
    }
    // --- Playwright-style locators ---
    locator(selector, options) {
        return new Locator(this, [{ kind: "css", selector }], options);
    }
    getByRole(role, options = {}) {
        return new Locator(this, [{ kind: "role", role, name: options.name, exact: options.exact }]);
    }
    getByText(text, options = {}) {
        return new Locator(this, [{ kind: "text", text, exact: options.exact }]);
    }
    getByLabel(text, options = {}) {
        return new Locator(this, [{ kind: "label", text, exact: options.exact }]);
    }
    getByPlaceholder(text, options = {}) {
        return new Locator(this, [{ kind: "placeholder", text, exact: options.exact }]);
    }
    getByAltText(text, options = {}) {
        return new Locator(this, [{ kind: "alt", text, exact: options.exact }]);
    }
    getByTitle(text, options = {}) {
        return new Locator(this, [{ kind: "title", text, exact: options.exact }]);
    }
    getByTestId(testId) {
        return new Locator(this, [{ kind: "testId", testId }]);
    }
    // --- Element actions (selector sugar over Locator) ---
    async click(selector, options = {}) {
        const nav = options.waitForNavigation
            ? this.waitForNavigation(typeof options.waitForNavigation === "object" ? options.waitForNavigation : {})
            : undefined;
        nav?.catch(() => undefined);
        await this.locator(selector).click(options);
        if (nav)
            await nav;
    }
    async fill(selector, text, options = {}) {
        return this.locator(selector).fill(text, options);
    }
    async hover(selector, options = {}) {
        return this.locator(selector).hover(options);
    }
    async check(selector, options = {}) {
        return this.locator(selector).check(options);
    }
    async uncheck(selector, options = {}) {
        return this.locator(selector).uncheck(options);
    }
    async selectOption(selector, values, options = {}) {
        return this.locator(selector).selectOption(values, options);
    }
    // --- Page metadata & navigation ---
    async title() {
        await this.init();
        return this.evaluate("document.title");
    }
    async url() {
        await this.init();
        return this.evaluate("location.href");
    }
    async reload(options = {}) {
        await this.init();
        this.network.reset();
        const waitPromise = this.waiter.waitForNavigation(options);
        waitPromise.catch(() => undefined);
        await this.session.send("Page.reload", { ignoreCache: false }, options.timeout);
        await waitPromise;
    }
    async goBack(options = {}) {
        await this.historyStep(-1, options);
    }
    async goForward(options = {}) {
        await this.historyStep(1, options);
    }
    async screenshot(options = {}) {
        await this.init();
        const format = options.type === "jpeg" ? "jpeg" : "png";
        const result = await this.session.send("Page.captureScreenshot", {
            format,
            quality: options.quality,
            fromSurface: true,
            captureBeyondViewport: options.fullPage ?? false,
        }, options.timeout);
        return Buffer.from(result.data, "base64");
    }
    async pdf(options = {}) {
        await this.init();
        const result = await this.session.send("Page.printToPDF", {}, options.timeout);
        return Buffer.from(result.data, "base64");
    }
    async addInitScript(source) {
        await this.init();
        const script = typeof source === "function" ? `(${source.toString()})();` : source;
        await this.session.send("Page.addScriptToEvaluateOnNewDocument", { source: script });
    }
    async setViewportSize(size) {
        await this.init();
        await this.session.send("Emulation.setDeviceMetricsOverride", {
            width: size.width,
            height: size.height,
            deviceScaleFactor: 1,
            mobile: false,
        });
    }
    /** Intercept network requests (Playwright-style `page.route`). */
    async route(pattern, handler) {
        await this.init();
        await this.routes.route(pattern, handler);
    }
    async unroute(pattern, handler) {
        await this.routes.unroute(pattern, handler);
    }
    async type(selector, text, options = {}) {
        return this.fill(selector, text, options);
    }
    async press(key, options = {}) {
        await this.init();
        const timeout = options.timeout ?? 30_000;
        const spec = keySpec(key);
        await this.session.send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: spec.key,
            code: spec.code,
            windowsVirtualKeyCode: spec.vk,
            nativeVirtualKeyCode: spec.vk,
        }, timeout);
        await this.session.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: spec.key,
            code: spec.code,
            windowsVirtualKeyCode: spec.vk,
            nativeVirtualKeyCode: spec.vk,
        }, timeout);
    }
    // --- Velora-specific (LP domain + agent workflows) ---
    markdown(options) {
        return this.agent.markdown(options);
    }
    semanticTree(options) {
        return this.agent.semanticTree(options);
    }
    getInteractiveElements(options) {
        return this.agent.getInteractiveElements(options);
    }
    getStructuredData(options) {
        return this.agent.getStructuredData(options);
    }
    detectForms(options) {
        return this.agent.detectForms(options);
    }
    findElement(options) {
        return this.agent.findElement(options);
    }
    getNodeDetails(backendNodeId, options) {
        return this.agent.getNodeDetails(backendNodeId, options);
    }
    links(options) {
        return this.agent.links(options);
    }
    node(backendNodeId) {
        return new NodeHandle(this, backendNodeId);
    }
    async waitForSelectorHandle(selector, options) {
        const id = await this.agent.waitForSelectorNode(selector, options);
        return new NodeHandle(this, id);
    }
    armDialog(options) {
        return this.agent.armDialog(options);
    }
    /** Google SERP agent workflow: navigate + TTFX probe + top-N organic extract + block detection. */
    searchGoogle(options) {
        return searchGoogle(this, options);
    }
    async search(searchPageUrl, query, options = {}) {
        await this.init();
        const timeout = options.timeout ?? 30_000;
        const inputSelector = options.inputSelector ?? 'textarea[name="q"], input[name="q"]';
        const waitUntil = options.waitUntil ?? "domcontentloaded";
        await this.goto(searchPageUrl, { waitUntil: "load", timeout });
        if (options.settleMs)
            await delay(options.settleMs);
        const nav = this.waiter.waitForNavigation({ waitUntil, timeout, networkIdleMs: options.networkIdleMs });
        nav.catch(() => undefined);
        await this.type(inputSelector, query, { timeout });
        await this.press("Enter", { timeout });
        await nav;
    }
    async close() {
        this.routes.dispose();
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
    async historyStep(delta, options = {}) {
        await this.init();
        this.network.reset();
        const waitPromise = this.waiter.waitForNavigation(options);
        waitPromise.catch(() => undefined);
        await this.evaluate(delta === -1 ? "history.back()" : "history.forward()");
        await waitPromise;
    }
}
function keySpec(key) {
    switch (key) {
        case "Enter": return { key: "Enter", code: "Enter", vk: 13 };
        case "Tab": return { key: "Tab", code: "Tab", vk: 9 };
        case "Escape": return { key: "Escape", code: "Escape", vk: 27 };
        case "Backspace": return { key: "Backspace", code: "Backspace", vk: 8 };
        default:
            if (key.length === 1) {
                const upper = key.toUpperCase();
                return { key, code: `Key${upper}`, vk: upper.charCodeAt(0) };
            }
            return { key, code: key, vk: 0 };
    }
}
//# sourceMappingURL=page.js.map