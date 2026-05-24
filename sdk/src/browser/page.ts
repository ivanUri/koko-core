import type { CDPSession } from "../cdp/session.js";
import { NavigationError, ProtocolError, TargetClosedError } from "../cdp/errors.js";
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
  private mainFrameId?: string;

  constructor(readonly session: CDPSession) {
    this.network = new NetworkTracker(session);
    this.waiter = new PageWaiter(session, this.network);
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
    const waitPromise = this.waiter.waitForNavigation(options);
    // Catch the wait promise eagerly so a navigation failure doesn't surface as unhandled rejection.
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

  /** Returns the main-frame id (after first navigation/init). */
  get frameId(): string | undefined {
    return this.mainFrameId;
  }

  private async contentFromDOM(): Promise<string | undefined> {
    const doc = await this.session.send<any>("DOM.getDocument", { depth: 0, pierce: false });
    const root = doc?.root;
    if (!root?.nodeId) return undefined;
    const result = await this.session.send<any>("DOM.getOuterHTML", { nodeId: root.nodeId });
    const html = result.outerHTML as string | undefined;
    if (!html) return undefined;
    if (/^\s*<!doctype/i.test(html)) return html;
    const doctype = await this.evaluate<string>("document.doctype ? new XMLSerializer().serializeToString(document.doctype) : ''").catch(() => "");
    return withDoctype(html, doctype);
  }
}

function withDoctype(html = "", doctype = ""): string {
  if (/^\s*<!doctype\s+/i.test(html)) return html;
  return `${doctype || "<!DOCTYPE html>"}\n${html}`;
}
