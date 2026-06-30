import type { Page } from "./page.js";
import type { GotoWaitOptions } from "./waiter.js";
import {
  locatorCheck,
  locatorClick,
  locatorFill,
  locatorHover,
  locatorSelectOption,
  type ActionOptions,
  type FillOptions,
  type SelectOptions,
} from "./actions.js";
import { buildCountExpression, buildResolveExpression, type LocatorQuery } from "./locator-query.js";

export interface LocatorOptions {
  /** When true, fail if locator resolves to more than one element. */
  has?: boolean;
}

export interface GetByRoleOptions {
  name?: string | RegExp;
  exact?: boolean;
}

export interface GetByTextOptions {
  exact?: boolean;
}

export interface LocatorPressOptions extends ActionOptions {
  /** Wait for navigation after key press (e.g. Enter on a form). */
  waitForNavigation?: boolean | GotoWaitOptions;
}

export class Locator {
  constructor(
    readonly page: Page,
    readonly queries: LocatorQuery[],
    readonly options: LocatorOptions = {},
  ) {}

  locator(selector: string): Locator {
    return new Locator(this.page, [...this.queries, { kind: "css", selector }], this.options);
  }

  getByRole(role: string, options: GetByRoleOptions = {}): Locator {
    return new Locator(this.page, [...this.queries, { kind: "role", role, name: options.name, exact: options.exact }], this.options);
  }

  getByText(text: string | RegExp, options: GetByTextOptions = {}): Locator {
    return new Locator(this.page, [...this.queries, { kind: "text", text, exact: options.exact }], this.options);
  }

  getByLabel(text: string | RegExp, options: GetByTextOptions = {}): Locator {
    return new Locator(this.page, [...this.queries, { kind: "label", text, exact: options.exact }], this.options);
  }

  getByPlaceholder(text: string | RegExp, options: GetByTextOptions = {}): Locator {
    return new Locator(this.page, [...this.queries, { kind: "placeholder", text, exact: options.exact }], this.options);
  }

  getByAltText(text: string | RegExp, options: GetByTextOptions = {}): Locator {
    return new Locator(this.page, [...this.queries, { kind: "alt", text, exact: options.exact }], this.options);
  }

  getByTitle(text: string | RegExp, options: GetByTextOptions = {}): Locator {
    return new Locator(this.page, [...this.queries, { kind: "title", text, exact: options.exact }], this.options);
  }

  getByTestId(testId: string | RegExp): Locator {
    return new Locator(this.page, [...this.queries, { kind: "testId", testId }], this.options);
  }

  first(): Locator {
    return this.nth(0);
  }

  last(): Locator {
    return this.nth(-1);
  }

  nth(index: number): Locator {
    const clone = new Locator(this.page, this.queries, this.options);
    clone._index = index;
    return clone;
  }

  private _index?: number;

  private resolveOptions(): { index?: number; strict?: boolean } {
    return { index: this._index, strict: this._index == null };
  }

  async click(options: ActionOptions = {}): Promise<void> {
    await this.page.init();
    await locatorClick(this.page, this.queries, options, this.resolveOptions());
  }

  async hover(options: ActionOptions = {}): Promise<void> {
    await this.page.init();
    await locatorHover(this.page, this.queries, options, this.resolveOptions());
  }

  async fill(text: string, options: FillOptions = {}): Promise<void> {
    await this.page.init();
    await locatorFill(this.page, this.queries, text, options, this.resolveOptions());
  }

  /** Alias for fill(). */
  async type(text: string, options: FillOptions = {}): Promise<void> {
    return this.fill(text, options);
  }

  async press(key: string, options: LocatorPressOptions = {}): Promise<void> {
    await this.page.init();
    const resolve = buildResolveExpression(this.queries, this.resolveOptions());
    await this.page.evaluate(`(() => {
      const el = ${resolve};
      if ('focus' in el && typeof el.focus === 'function') el.focus();
      return true;
    })()`, { timeout: options.timeout });
    const nav = options.waitForNavigation
      ? this.page.waitForNavigation(typeof options.waitForNavigation === "object" ? options.waitForNavigation : {})
      : undefined;
    nav?.catch(() => undefined);
    await this.page.press(key, { timeout: options.timeout });
    if (nav) await nav;
  }

  async check(options: ActionOptions = {}): Promise<void> {
    await locatorCheck(this.page, this.queries, true, options, this.resolveOptions());
  }

  async uncheck(options: ActionOptions = {}): Promise<void> {
    await locatorCheck(this.page, this.queries, false, options, this.resolveOptions());
  }

  async selectOption(values: SelectOptions["values"], options: SelectOptions = {}): Promise<string[]> {
    await this.page.init();
    return locatorSelectOption(this.page, this.queries, values, options, this.resolveOptions());
  }

  async textContent(options: ActionOptions = {}): Promise<string | null> {
    const resolve = buildResolveExpression(this.queries, this.resolveOptions());
    return this.page.evaluate<string | null>(`(() => {
      const el = ${resolve};
      return el.textContent?.trim() ?? null;
    })()`, { timeout: options.timeout });
  }

  async innerText(options: ActionOptions = {}): Promise<string> {
    const resolve = buildResolveExpression(this.queries, this.resolveOptions());
    return this.page.evaluate<string>(`(() => {
      const el = ${resolve};
      return (el.innerText ?? el.textContent ?? '').trim();
    })()`, { timeout: options.timeout });
  }

  async innerHTML(options: ActionOptions = {}): Promise<string> {
    const resolve = buildResolveExpression(this.queries, this.resolveOptions());
    return this.page.evaluate<string>(`(() => {
      const el = ${resolve};
      return el.innerHTML ?? '';
    })()`, { timeout: options.timeout });
  }

  async getAttribute(name: string, options: ActionOptions = {}): Promise<string | null> {
    const resolve = buildResolveExpression(this.queries, this.resolveOptions());
    const attr = JSON.stringify(name);
    return this.page.evaluate<string | null>(`(() => {
      const el = ${resolve};
      return el.getAttribute(${attr});
    })()`, { timeout: options.timeout });
  }

  async isVisible(options: ActionOptions = {}): Promise<boolean> {
    const resolve = buildResolveExpression(this.queries, this.resolveOptions());
    return this.page.evaluate<boolean>(`(() => {
      const el = ${resolve};
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    })()`, { timeout: options.timeout }).catch(() => false);
  }

  async isHidden(options: ActionOptions = {}): Promise<boolean> {
    return !(await this.isVisible(options));
  }

  async isEnabled(options: ActionOptions = {}): Promise<boolean> {
    const resolve = buildResolveExpression(this.queries, this.resolveOptions());
    return this.page.evaluate<boolean>(`(() => {
      const el = ${resolve};
      return !el.hasAttribute('disabled') && !el.closest('[disabled]');
    })()`, { timeout: options.timeout }).catch(() => false);
  }

  async isChecked(options: ActionOptions = {}): Promise<boolean> {
    const resolve = buildResolveExpression(this.queries, this.resolveOptions());
    return this.page.evaluate<boolean>(`(() => {
      const el = ${resolve};
      return 'checked' in el ? !!el.checked : false;
    })()`, { timeout: options.timeout }).catch(() => false);
  }

  async count(): Promise<number> {
    await this.page.init();
    return this.page.evaluate<number>(buildCountExpression(this.queries));
  }

  async waitFor(options: { state?: "attached" | "visible" | "hidden"; timeout?: number } = {}): Promise<void> {
    const state = options.state ?? "visible";
    const timeout = options.timeout ?? 30_000;
    if (state === "hidden") {
      await this.page.waitForFunction(`!(() => { try { return (${buildCountExpression(this.queries)}) > 0; } catch { return false; } })()`, { timeout });
      return;
    }
    const expr = state === "attached"
      ? `(() => { try { return (${buildCountExpression(this.queries)}) > 0; } catch { return false; } })()`
      : `(() => {
          try {
            const el = ${buildResolveExpression(this.queries, this.resolveOptions())};
            const style = getComputedStyle(el);
            const rect = el.getBoundingClientRect();
            return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
          } catch { return false; }
        })()`;
    await this.page.waitForFunction(expr, { timeout });
  }
}