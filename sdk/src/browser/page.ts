import type { CDPSession } from "../cdp/session.js";
import { NavigationError } from "../cdp/errors.js";
import type { GotoWaitOptions } from "./waiter.js";
import { PageWaiter } from "./waiter.js";
import { NetworkTracker } from "./network.js";

export interface EvaluateOptions {
  timeout?: number;
}

export class Page {
  readonly network: NetworkTracker;
  readonly waiter: PageWaiter;
  private initialized = false;

  constructor(readonly session: CDPSession) {
    this.network = new NetworkTracker(session);
    this.waiter = new PageWaiter(session, this.network);
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.session.send("Page.enable").catch(() => undefined);
    await this.session.send("Runtime.enable").catch(() => undefined);
    await this.network.enable();
    this.initialized = true;
  }

  async goto(url: string, options: GotoWaitOptions = {}): Promise<void> {
    await this.init();
    const waitPromise = this.waiter.waitForNavigation(options);
    const result = await this.session.send<any>("Page.navigate", { url }, options.timeout);
    if (result.errorText) throw new NavigationError(result.errorText, { method: "Page.navigate", sessionId: this.session.sessionId, payload: result });
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
      throw new NavigationError("Runtime.evaluate failed", {
        method: "Runtime.evaluate",
        sessionId: this.session.sessionId,
        payload: result.exceptionDetails,
      });
    }
    return result.result?.value as T;
  }

  async content(): Promise<string> {
    await this.init();
    const domHtml = await this.contentFromDOM().catch(() => undefined);
    if (domHtml) return domHtml;

    const html = await this.evaluate<string>("document.documentElement ? document.documentElement.outerHTML : ''");
    const doctype = await this.evaluate<string>("document.doctype ? new XMLSerializer().serializeToString(document.doctype) : ''").catch(() => "");
    return withDoctype(html, doctype);
  }

  waitForSelector(selector: string, options?: { timeout?: number; visible?: boolean }): Promise<void> {
    return this.waiter.waitForSelector(selector, options);
  }

  waitForFunction(fn: string | Function, options?: { timeout?: number; pollingMs?: number }): Promise<void> {
    return this.waiter.waitForFunction(fn, options);
  }

  async close(): Promise<void> {
    this.network.dispose();
    if (this.session.targetId) await this.session.client.closeTarget(this.session.targetId).catch(() => undefined);
    await this.session.detach().catch(() => undefined);
  }

  private async contentFromDOM(): Promise<string | undefined> {
    const { root } = await this.session.send<any>("DOM.getDocument", { depth: 0 });
    if (!root?.nodeId) return undefined;
    const result = await this.session.send<any>("DOM.getOuterHTML", { nodeId: root.nodeId });
    const html = result.outerHTML as string | undefined;
    if (!html) return undefined;
    const doctype = await this.evaluate<string>("document.doctype ? new XMLSerializer().serializeToString(document.doctype) : ''").catch(() => "");
    return withDoctype(html, doctype);
  }
}

function withDoctype(html = "", doctype = ""): string {
  if (/^\s*<!doctype\s+/i.test(html)) return html;
  return `${doctype || "<!DOCTYPE html>"}\n${html}`;
}
