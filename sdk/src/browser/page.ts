import type { CDPSession } from "../cdp/session.js";
import { NavigationError, ProtocolError, TargetClosedError } from "../cdp/errors.js";
import { delay } from "../utils/timeout.js";
import type { GotoWaitOptions } from "./waiter.js";
import { PageWaiter } from "./waiter.js";
import { NetworkTracker } from "./network.js";

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
  private initialized = false;
  private mainFrameId?: string;
  private readonly closeHooks = new Set<() => void>();

  constructor(readonly session: CDPSession) {
    this.network = new NetworkTracker(session);
    this.waiter = new PageWaiter(session, this.network);
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

  async type(selector: string, text: string, options: TypeOptions = {}): Promise<void> {
    await this.init();
    const timeout = options.timeout ?? 30_000;
    await this.waitForSelector(selector, { timeout });
    const clearFirst = options.clear !== false;
    await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || !('value' in el)) throw new Error('type: not an input element');
      if (${clearFirst ? "true" : "false"}) el.value = '';
      el.focus();
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`, { timeout });
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
    this.network.dispose();
    if (this.session.targetId) await this.session.client.closeTarget(this.session.targetId).catch(() => undefined);
    await this.session.detach().catch(() => undefined);
    for (const hook of this.closeHooks) hook();
    this.closeHooks.clear();
  }

  get frameId(): string | undefined {
    return this.mainFrameId;
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