import { locatorCheck, locatorClick, locatorFill, locatorHover, locatorSelectOption, } from "./actions.js";
import { buildCountExpression, buildResolveExpression } from "./locator-query.js";
export class Locator {
    page;
    queries;
    options;
    constructor(page, queries, options = {}) {
        this.page = page;
        this.queries = queries;
        this.options = options;
    }
    locator(selector) {
        return new Locator(this.page, [...this.queries, { kind: "css", selector }], this.options);
    }
    getByRole(role, options = {}) {
        return new Locator(this.page, [...this.queries, { kind: "role", role, name: options.name, exact: options.exact }], this.options);
    }
    getByText(text, options = {}) {
        return new Locator(this.page, [...this.queries, { kind: "text", text, exact: options.exact }], this.options);
    }
    getByLabel(text, options = {}) {
        return new Locator(this.page, [...this.queries, { kind: "label", text, exact: options.exact }], this.options);
    }
    getByPlaceholder(text, options = {}) {
        return new Locator(this.page, [...this.queries, { kind: "placeholder", text, exact: options.exact }], this.options);
    }
    getByAltText(text, options = {}) {
        return new Locator(this.page, [...this.queries, { kind: "alt", text, exact: options.exact }], this.options);
    }
    getByTitle(text, options = {}) {
        return new Locator(this.page, [...this.queries, { kind: "title", text, exact: options.exact }], this.options);
    }
    getByTestId(testId) {
        return new Locator(this.page, [...this.queries, { kind: "testId", testId }], this.options);
    }
    first() {
        return this.nth(0);
    }
    last() {
        return this.nth(-1);
    }
    nth(index) {
        const clone = new Locator(this.page, this.queries, this.options);
        clone._index = index;
        return clone;
    }
    _index;
    resolveOptions() {
        return { index: this._index, strict: this._index == null };
    }
    async click(options = {}) {
        await this.page.init();
        await locatorClick(this.page, this.queries, options, this.resolveOptions());
    }
    async hover(options = {}) {
        await this.page.init();
        await locatorHover(this.page, this.queries, options, this.resolveOptions());
    }
    async fill(text, options = {}) {
        await this.page.init();
        await locatorFill(this.page, this.queries, text, options, this.resolveOptions());
    }
    /** Alias for fill(). */
    async type(text, options = {}) {
        return this.fill(text, options);
    }
    async press(key, options = {}) {
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
        if (nav)
            await nav;
    }
    async check(options = {}) {
        await locatorCheck(this.page, this.queries, true, options, this.resolveOptions());
    }
    async uncheck(options = {}) {
        await locatorCheck(this.page, this.queries, false, options, this.resolveOptions());
    }
    async selectOption(values, options = {}) {
        await this.page.init();
        return locatorSelectOption(this.page, this.queries, values, options, this.resolveOptions());
    }
    async textContent(options = {}) {
        const resolve = buildResolveExpression(this.queries, this.resolveOptions());
        return this.page.evaluate(`(() => {
      const el = ${resolve};
      return el.textContent?.trim() ?? null;
    })()`, { timeout: options.timeout });
    }
    async innerText(options = {}) {
        const resolve = buildResolveExpression(this.queries, this.resolveOptions());
        return this.page.evaluate(`(() => {
      const el = ${resolve};
      return (el.innerText ?? el.textContent ?? '').trim();
    })()`, { timeout: options.timeout });
    }
    async innerHTML(options = {}) {
        const resolve = buildResolveExpression(this.queries, this.resolveOptions());
        return this.page.evaluate(`(() => {
      const el = ${resolve};
      return el.innerHTML ?? '';
    })()`, { timeout: options.timeout });
    }
    async getAttribute(name, options = {}) {
        const resolve = buildResolveExpression(this.queries, this.resolveOptions());
        const attr = JSON.stringify(name);
        return this.page.evaluate(`(() => {
      const el = ${resolve};
      return el.getAttribute(${attr});
    })()`, { timeout: options.timeout });
    }
    async isVisible(options = {}) {
        const resolve = buildResolveExpression(this.queries, this.resolveOptions());
        return this.page.evaluate(`(() => {
      const el = ${resolve};
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    })()`, { timeout: options.timeout }).catch(() => false);
    }
    async isHidden(options = {}) {
        return !(await this.isVisible(options));
    }
    async isEnabled(options = {}) {
        const resolve = buildResolveExpression(this.queries, this.resolveOptions());
        return this.page.evaluate(`(() => {
      const el = ${resolve};
      return !el.hasAttribute('disabled') && !el.closest('[disabled]');
    })()`, { timeout: options.timeout }).catch(() => false);
    }
    async isChecked(options = {}) {
        const resolve = buildResolveExpression(this.queries, this.resolveOptions());
        return this.page.evaluate(`(() => {
      const el = ${resolve};
      return 'checked' in el ? !!el.checked : false;
    })()`, { timeout: options.timeout }).catch(() => false);
    }
    async count() {
        await this.page.init();
        return this.page.evaluate(buildCountExpression(this.queries));
    }
    async waitFor(options = {}) {
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
//# sourceMappingURL=locator.js.map