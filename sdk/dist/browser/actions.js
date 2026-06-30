import { buildResolveExpression } from "./locator-query.js";
async function runOnLocator(page, queries, body, options = {}, resolveOptions = {}) {
    const resolve = buildResolveExpression(queries, resolveOptions);
    const timeout = options.timeout ?? 30_000;
    await page.evaluate(`(() => {
    const el = ${resolve};
    ${body}
    return true;
  })()`, { timeout });
}
export async function locatorClick(page, queries, options = {}, resolveOptions = {}) {
    await runOnLocator(page, queries, `
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  `, options, resolveOptions);
}
export async function locatorHover(page, queries, options = {}, resolveOptions = {}) {
    await runOnLocator(page, queries, `
    el.scrollIntoView({ block: 'center', inline: 'center' });
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: false }));
  `, options, resolveOptions);
}
export async function locatorFill(page, queries, text, options = {}, resolveOptions = {}) {
    const clearFirst = options.clear !== false;
    const value = JSON.stringify(text);
    await runOnLocator(page, queries, `
    if ('focus' in el && typeof el.focus === 'function') el.focus();
    if (el.tagName === 'SELECT') {
      const wanted = ${value};
      const opt = [...el.options].find((o) => o.value === wanted || o.text === wanted);
      if (!opt) throw new Error('selectOption: no matching option');
      el.value = opt.value;
    } else if ('value' in el) {
      if (${clearFirst ? "true" : "false"}) el.value = '';
      el.value = ${value};
    } else if (el.isContentEditable) {
      if (${clearFirst ? "true" : "false"}) el.textContent = '';
      el.textContent = ${value};
    } else {
      throw new Error('fill: element is not fillable');
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  `, options, resolveOptions);
}
export async function locatorCheck(page, queries, checked, options = {}, resolveOptions = {}) {
    await runOnLocator(page, queries, `
    if (!('checked' in el)) throw new Error('check: not a checkbox/radio');
    if (el.checked === ${checked ? "true" : "false"}) return;
    el.checked = ${checked ? "true" : "false"};
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  `, options, resolveOptions);
}
export async function locatorSelectOption(page, queries, values, options = {}, resolveOptions = {}) {
    const resolve = buildResolveExpression(queries, resolveOptions);
    const timeout = options.timeout ?? 30_000;
    const payload = JSON.stringify(normalizeSelectValues(values));
    return page.evaluate(`(() => {
    const el = ${resolve};
    if (el.tagName !== 'SELECT') throw new Error('selectOption: not a select element');
    const specs = ${payload};
    const selected = [];
    for (const spec of specs) {
      let opt = null;
      if (spec.value != null) opt = [...el.options].find((o) => o.value === spec.value);
      else if (spec.label != null) opt = [...el.options].find((o) => o.text === spec.label);
      else if (spec.index != null) opt = el.options[spec.index] ?? null;
      if (!opt) throw new Error('selectOption: no matching option');
      if (el.multiple) opt.selected = true;
      else el.value = opt.value;
      selected.push(opt.value);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return selected;
  })()`, { timeout });
}
function normalizeSelectValues(values) {
    if (values == null)
        return [];
    const list = Array.isArray(values) ? values : [values];
    return list.map((item) => {
        if (typeof item === "string")
            return { value: item };
        return item;
    });
}
//# sourceMappingURL=actions.js.map