import type { CDPSession } from "../cdp/session.js";
import { ProtocolError, TimeoutError } from "../cdp/errors.js";
import { delay, withTimeout } from "../utils/timeout.js";
import type { NetworkTracker } from "./network.js";

export type WaitUntil = "none" | "commit" | "domcontentloaded" | "load" | "networkidle";

export interface GotoWaitOptions {
  waitUntil?: WaitUntil;
  timeout?: number;
  networkIdleMs?: number;
}

export interface InternalWaitOptions extends GotoWaitOptions {
  /** loaderId returned by Page.navigate; used to disambiguate concurrent navigations. */
  loaderId?: string;
  /** frameId returned by Page.navigate (main frame). */
  frameId?: string;
}

export class PageWaiter {
  constructor(private readonly session: CDPSession, private readonly network: NetworkTracker) {}

  async waitForNavigation(options: InternalWaitOptions = {}): Promise<void> {
    const waitUntil = options.waitUntil ?? "load";
    if (waitUntil === "none" || waitUntil === "commit") return;
    const timeout = options.timeout ?? 30_000;

    if (waitUntil === "domcontentloaded") {
      await this.session.waitFor("Page.domContentEventFired", { timeout });
      return;
    }
    if (waitUntil === "load") {
      await this.session.waitFor("Page.loadEventFired", { timeout });
      return;
    }
    // networkidle: still wait for at least the load event before measuring idle.
    await this.session.waitFor("Page.loadEventFired", { timeout }).catch(() => undefined);
    await this.network.waitForIdle({ idleMs: options.networkIdleMs, timeout });
  }

  async waitForSelector(selector: string, options: { timeout?: number; visible?: boolean } = {}): Promise<void> {
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

  async waitForFunction(fn: string | Function, options: { timeout?: number; pollingMs?: number } = {}): Promise<void> {
    const source = typeof fn === "function" ? `(${fn.toString()})()` : `(${fn})`;
    await this.pollExpression(source, options.timeout, "Waiting for function", options.pollingMs);
  }

  private async pollExpression(expression: string, timeout = 30_000, label: string, pollingMs = 100): Promise<void> {
    const started = Date.now();
    await withTimeout((async () => {
      while (true) {
        const result = await this.session.send<any>("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        });
        if (result.exceptionDetails) {
          const ex = result.exceptionDetails as any;
          const desc = ex?.exception?.description ?? ex?.text ?? `${label} failed`;
          throw new ProtocolError(desc, { payload: result.exceptionDetails });
        }
        if (result.result?.value) return;
        if (Date.now() - started > timeout) throw new TimeoutError(label, { timeout });
        await delay(pollingMs);
      }
    })(), { timeout, label });
  }
}
