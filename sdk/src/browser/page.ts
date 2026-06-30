import type { CDPSession } from "../cdp/session.js";
import { NavigationError, ProtocolError, TargetClosedError } from "../cdp/errors.js";
import { delay } from "../utils/timeout.js";
import type { GotoWaitOptions } from "./waiter.js";
import { PageWaiter } from "./waiter.js";
import { NetworkTracker } from "./network.js";
import { RouteRegistry, type RouteHandler, type RoutePattern } from "./route.js";
import { Locator, type GetByRoleOptions, type GetByTextOptions, type LocatorOptions } from "./locator.js";
import type { ActionOptions, FillOptions, SelectOptions } from "./actions.js";
import { LPClient } from "./lp-client.js";
import { NodeHandle } from "./node-handle.js";
import { searchGoogle } from "./google-search.js";
import type {
  DetectedForm,
  DialogOptions,
  FindElementOptions,
  GoogleExtractResult,
  GoogleSearchOptions,
  InteractiveElement,
  MarkdownOptions,
  NodeDetails,
  SemanticNode,
  SemanticTreeOptions,
  StructuredData,
} from "./lp-types.js";

export interface EvaluateOptions {
  timeout?: number;
}

export interface ExtractOptions {
  /** Expression that must become truthy before extract runs (TTFX probe). */
  ttfx?: string;
  /** Final extract expression; must returnByValue. */
  expression?: string;
  timeout?: number;
  pollMs?: number;
}

export interface ExtractResult {
  title?: string;
  linkCount?: number;
  htmlBytes?: number;
  [key: string]: unknown;
}

export interface TypeOptions {
  timeout?: number;
  clear?: boolean;
}

export interface PressOptions {
  timeout?: number;
}

export interface SearchOptions extends GotoWaitOptions {
  inputSelector?: string;
  settleMs?: number;
}

export interface ScreenshotOptions {
  timeout?: number;
  type?: "png" | "jpeg";
  quality?: number;
  fullPage?: boolean;
}

export interface PdfOptions {
  timeout?: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface ClickOptions extends ActionOptions {
  waitForNavigation?: boolean | GotoWaitOptions;
}

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
  readonly network: NetworkTracker;
  readonly waiter: PageWaiter;
  /** Velora LP domain — AI extraction and backend-node agent actions. */
  readonly agent: LPClient;
  private readonly routes: RouteRegistry;
  private initialized = false;
  private mainFrameId?: string;
  private readonly closeHooks = new Set<() => void>();

  constructor(readonly session: CDPSession) {
    this.routes = new RouteRegistry(session);
    this.network = new NetworkTracker(session);
    this.waiter = new PageWaiter(session, this.network);
    this.agent = new LPClient(this, session);
  }

  /** Register cleanup when page.close() runs (used by Browser/Context). */
  onClose(hook: () => void): void {
    this.closeHooks.add(hook);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.session.on<any>("Page.frameNavigated", (event) => {
      const frame = event?.frame;
      if (frame && !frame.parentId) this.mainFrameId = frame.id;
    });
    this.session.on<any>("Inspector.detached", (event) => {
      this.session.markClosed(new TargetClosedError(event?.reason ?? "Inspector detached", { sessionId: this.session.sessionId }));
    });

    await this.session.send("Page.enable").catch(() => undefined);
    await this.session.send("Runtime.enable").catch(() => undefined);
    await this.network.enable();

    const tree = await this.session.send<any>("Page.getFrameTree").catch(() => undefined);
    this.mainFrameId = tree?.frameTree?.frame?.id ?? this.mainFrameId;
  }

  async goto(url: string, options: GotoWaitOptions = {}): Promise<void> {
    await this.init();
    this.network.reset();
    const waitPromise = this.waiter.waitForNavigation(options);
    waitPromise.catch(() => undefined);
    const result = await this.session.send<any>("Page.navigate", { url }, options.timeout);
    if (result.errorText) {
      throw new NavigationError(result.errorText, { method: "Page.navigate", sessionId: this.session.sessionId, payload: result });
    }
    if (result.frameId) this.mainFrameId = result.frameId;
    await waitPromise;
  }

  async evaluate<T = unknown>(expressionOrFunction: string | Function, options: EvaluateOptions = {}): Promise<T> {
    await this.init();
    const expression = typeof expressionOrFunction === "function"
      ? `(${expressionOrFunction.toString()})()`
      : expressionOrFunction;
    const result = await this.session.send<any>("Runtime.evaluate", {
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
    return result.result?.value as T;
  }

  /** Single round-trip HTML snapshot (doctype + outerHTML). */
  async content(): Promise<string> {
    await this.init();
    return this.evaluate<string>(CONTENT_EXPR);
  }

  /**
   * Crawler helper: wait for a TTFX probe then run a structured extract expression.
   * Defaults match the Wikipedia crawl benchmark.
   */
  async extract(options: ExtractOptions = {}): Promise<ExtractResult> {
    await this.init();
    const timeout = options.timeout ?? 30_000;
    const ttfx = options.ttfx ?? DEFAULT_TTFX;
    const expression = options.expression ?? DEFAULT_EXTRACT;
    await this.waiter.pollUntilTruthy(ttfx, { timeout, label: "Waiting for extractable content" });
    const value = await this.evaluate<ExtractResult>(expression, { timeout });
    if (!value || typeof value !== "object") {
      throw new ProtocolError("extract returned invalid payload", { method: "Page.extract" });
    }
    return value;
  }

  waitForSelector(selector: string, options?: { timeout?: number; visible?: boolean }): Promise<void> {
    return this.waiter.waitForSelector(selector, options);
  }

  waitForFunction(fn: string | Function, options?: { timeout?: number; pollingMs?: number }): Promise<void> {
    return this.waiter.waitForFunction(fn, options);
  }

  waitForNavigation(options: GotoWaitOptions = {}): Promise<void> {
    return this.waiter.waitForNavigation(options);
  }

  waitForURL(url: string | RegExp | ((current: string) => boolean), options?: { timeout?: number }): Promise<void> {
    return this.waiter.waitForURL(url, options);
  }

  // --- Playwright-style locators ---

  locator(selector: string, options?: LocatorOptions): Locator {
    return new Locator(this, [{ kind: "css", selector }], options);
  }

  getByRole(role: string, options: GetByRoleOptions = {}): Locator {
    return new Locator(this, [{ kind: "role", role, name: options.name, exact: options.exact }]);
  }

  getByText(text: string | RegExp, options: GetByTextOptions = {}): Locator {
    return new Locator(this, [{ kind: "text", text, exact: options.exact }]);
  }

  getByLabel(text: string | RegExp, options: GetByTextOptions = {}): Locator {
    return new Locator(this, [{ kind: "label", text, exact: options.exact }]);
  }

  getByPlaceholder(text: string | RegExp, options: GetByTextOptions = {}): Locator {
    return new Locator(this, [{ kind: "placeholder", text, exact: options.exact }]);
  }

  getByAltText(text: string | RegExp, options: GetByTextOptions = {}): Locator {
    return new Locator(this, [{ kind: "alt", text, exact: options.exact }]);
  }

  getByTitle(text: string | RegExp, options: GetByTextOptions = {}): Locator {
    return new Locator(this, [{ kind: "title", text, exact: options.exact }]);
  }

  getByTestId(testId: string | RegExp): Locator {
    return new Locator(this, [{ kind: "testId", testId }]);
  }

  // --- Element actions (selector sugar over Locator) ---

  async click(selector: string, options: ClickOptions = {}): Promise<void> {
    const nav = options.waitForNavigation
      ? this.waitForNavigation(typeof options.waitForNavigation === "object" ? options.waitForNavigation : {})
      : undefined;
    nav?.catch(() => undefined);
    await this.locator(selector).click(options);
    if (nav) await nav;
  }

  async fill(selector: string, text: string, options: FillOptions = {}): Promise<void> {
    return this.locator(selector).fill(text, options);
  }

  async hover(selector: string, options: ActionOptions = {}): Promise<void> {
    return this.locator(selector).hover(options);
  }

  async check(selector: string, options: ActionOptions = {}): Promise<void> {
    return this.locator(selector).check(options);
  }

  async uncheck(selector: string, options: ActionOptions = {}): Promise<void> {
    return this.locator(selector).uncheck(options);
  }

  async selectOption(selector: string, values: SelectOptions["values"], options: SelectOptions = {}): Promise<string[]> {
    return this.locator(selector).selectOption(values, options);
  }

  // --- Page metadata & navigation ---

  async title(): Promise<string> {
    await this.init();
    return this.evaluate<string>("document.title");
  }

  async url(): Promise<string> {
    await this.init();
    return this.evaluate<string>("location.href");
  }

  async reload(options: GotoWaitOptions = {}): Promise<void> {
    await this.init();
    this.network.reset();
    const waitPromise = this.waiter.waitForNavigation(options);
    waitPromise.catch(() => undefined);
    await this.session.send("Page.reload", { ignoreCache: false }, options.timeout);
    await waitPromise;
  }

  async goBack(options: GotoWaitOptions = {}): Promise<void> {
    await this.historyStep(-1, options);
  }

  async goForward(options: GotoWaitOptions = {}): Promise<void> {
    await this.historyStep(1, options);
  }

  async screenshot(options: ScreenshotOptions = {}): Promise<Buffer> {
    await this.init();
    const format = options.type === "jpeg" ? "jpeg" : "png";
    const result = await this.session.send<{ data: string }>("Page.captureScreenshot", {
      format,
      quality: options.quality,
      fromSurface: true,
      captureBeyondViewport: options.fullPage ?? false,
    }, options.timeout);
    return Buffer.from(result.data, "base64");
  }

  async pdf(options: PdfOptions = {}): Promise<Buffer> {
    await this.init();
    const result = await this.session.send<{ data: string }>("Page.printToPDF", {}, options.timeout);
    return Buffer.from(result.data, "base64");
  }

  async addInitScript(source: string | Function): Promise<void> {
    await this.init();
    const script = typeof source === "function" ? `(${source.toString()})();` : source;
    await this.session.send("Page.addScriptToEvaluateOnNewDocument", { source: script });
  }

  async setViewportSize(size: ViewportSize): Promise<void> {
    await this.init();
    await this.session.send("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height: size.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  /** Intercept network requests (Playwright-style `page.route`). */
  async route(pattern: RoutePattern, handler: RouteHandler): Promise<void> {
    await this.init();
    await this.routes.route(pattern, handler);
  }

  async unroute(pattern?: RoutePattern, handler?: RouteHandler): Promise<void> {
    await this.routes.unroute(pattern, handler);
  }

  async type(selector: string, text: string, options: TypeOptions = {}): Promise<void> {
    return this.fill(selector, text, options);
  }

  async press(key: string, options: PressOptions = {}): Promise<void> {
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

  markdown(options?: MarkdownOptions): Promise<string> {
    return this.agent.markdown(options);
  }

  semanticTree(options?: SemanticTreeOptions): Promise<string | SemanticNode> {
    return this.agent.semanticTree(options);
  }

  getInteractiveElements(options?: { nodeId?: number; timeout?: number }): Promise<InteractiveElement[]> {
    return this.agent.getInteractiveElements(options);
  }

  getStructuredData(options?: { timeout?: number }): Promise<StructuredData> {
    return this.agent.getStructuredData(options);
  }

  detectForms(options?: { timeout?: number }): Promise<DetectedForm[]> {
    return this.agent.detectForms(options);
  }

  findElement(options: FindElementOptions): Promise<InteractiveElement[]> {
    return this.agent.findElement(options);
  }

  getNodeDetails(backendNodeId: number, options?: { timeout?: number }): Promise<NodeDetails> {
    return this.agent.getNodeDetails(backendNodeId, options);
  }

  links(options?: { timeout?: number }): Promise<string[]> {
    return this.agent.links(options);
  }

  node(backendNodeId: number): NodeHandle {
    return new NodeHandle(this, backendNodeId);
  }

  async waitForSelectorHandle(selector: string, options?: { timeout?: number }): Promise<NodeHandle> {
    const id = await this.agent.waitForSelectorNode(selector, options);
    return new NodeHandle(this, id);
  }

  armDialog(options: DialogOptions): Promise<void> {
    return this.agent.armDialog(options);
  }

  /** Google SERP agent workflow: navigate + TTFX probe + top-N organic extract + block detection. */
  searchGoogle(options: GoogleSearchOptions): Promise<GoogleExtractResult> {
    return searchGoogle(this, options);
  }

  async search(searchPageUrl: string, query: string, options: SearchOptions = {}): Promise<void> {
    await this.init();
    const timeout = options.timeout ?? 30_000;
    const inputSelector = options.inputSelector ?? 'textarea[name="q"], input[name="q"]';
    const waitUntil = options.waitUntil ?? "domcontentloaded";

    await this.goto(searchPageUrl, { waitUntil: "load", timeout });
    if (options.settleMs) await delay(options.settleMs);

    const nav = this.waiter.waitForNavigation({ waitUntil, timeout, networkIdleMs: options.networkIdleMs });
    nav.catch(() => undefined);
    await this.type(inputSelector, query, { timeout });
    await this.press("Enter", { timeout });
    await nav;
  }

  async close(): Promise<void> {
    this.routes.dispose();
    this.network.dispose();
    if (this.session.targetId) await this.session.client.closeTarget(this.session.targetId).catch(() => undefined);
    await this.session.detach().catch(() => undefined);
    for (const hook of this.closeHooks) hook();
    this.closeHooks.clear();
  }

  get frameId(): string | undefined {
    return this.mainFrameId;
  }

  private async historyStep(delta: -1 | 1, options: GotoWaitOptions = {}): Promise<void> {
    await this.init();
    this.network.reset();
    const waitPromise = this.waiter.waitForNavigation(options);
    waitPromise.catch(() => undefined);
    await this.evaluate(delta === -1 ? "history.back()" : "history.forward()");
    await waitPromise;
  }
}

function keySpec(key: string): { key: string; code: string; vk: number } {
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