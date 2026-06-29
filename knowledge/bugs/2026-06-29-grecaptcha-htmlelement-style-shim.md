# grecaptcha fails to mount on Google /sorry — HTMLElement.style deleted by compat shim

## Summary

On flagged Google Search IPs, Velora loaded `enterprise.js` and `recaptcha__en.js` but never rendered the captcha widget (`cfgClients=0`, empty `#recaptcha` div). Root cause was `element.style` returning `undefined` because `creepjs_compat_shim.js` deleted `style` (and `dataset`, `offsetWidth`, …) from `Element.prototype` without copying them to `HTMLElement.prototype`. reCAPTCHA's render path sets inline styles on wrapper elements; without `style`, render throws and clients stay empty.

---

## Problem

Sorry-page parity compare showed:

| Signal | Chrome | Velora (before) |
|--------|--------|-----------------|
| `cfgClients` | 1 | 0 |
| `hasRecaptchaIframe` | true | false |
| recaptcha network hits | 9 | 2 |

Manual CDP probe on Velora sorry page:

```js
grecaptcha.enterprise.render('recaptcha')
// TypeError: Cannot read properties of undefined (reading 'width')

document.createElement('div').style  // undefined
```

---

## Root Cause

1. Velora exposes `Element.prototype.style` via `Element.JsApi` at snapshot time.
2. At context init, `creepjs_compat_shim.js` moves several IDL members from `Element` to `HTMLElement` (Chrome prototype layout for CreepJS).
3. The move guard used `key in HTMLElement.prototype`, which is **true for inherited** properties on `Element.prototype`.
4. The shim therefore **skipped** `Object.defineProperty(HTMLElement.prototype, key, desc)` but still ran `delete Element.prototype[key]` when configurable.
5. Result: `style`, `dataset`, `offsetWidth`, `offsetHeight`, etc. vanished from the entire prototype chain.
6. reCAPTCHA `render()` creates DOM nodes and assigns `element.style.width` / `height`; with `style === undefined`, render aborts before anchor iframe creation.

This was not a timing/`window.load` issue, `crossOrigin`, or `recaptcha__en.js` eval failure — the scripts ran, but layout/render crashed on missing `CSSStyleDeclaration`.

---

## Investigation

1. `npm run google:sorry-parity` — confirmed `cfgClients=0` vs Chrome `1`.
2. CDP `Runtime.evaluate` on live Velora sorry session — `grecaptcha.enterprise.render` stack pointed at `recaptcha__en.js` reading `.width` on undefined.
3. Prototype descriptor audit on fresh Velora context:

```js
Object.getOwnPropertyDescriptor(Element.prototype, 'style')   // null
Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style') // null
Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth') // getter (still present)
```

4. Traced `creepjs_compat_shim.js` move loop — `in` operator vs own-property semantics.

---

## Solution

Two changes (belt and suspenders):

1. **Fix shim guard** (`src/core/js/creepjs_compat_shim.js`): use `Object.prototype.hasOwnProperty.call(HTMLElement.prototype, key)` before define/delete, so inherited Element accessors are actually copied before removal.

2. **Spec-correct HTMLElement IDL** (`src/core/webapi/element/Html.zig`): add `style`, `dataset`, `offsetTop`, `offsetLeft`, `offsetWidth`, `offsetHeight` on `HTMLElement.JsApi`, delegating to `Element` helpers.

After fix:

```
cfgClients: 1
hasRecaptchaIframe: true
recaptchaChildren: 1
div.style.width = '304px' // works
```

Sorry parity: recaptcha chain 2 → 6 hits; anchor + webworker load. bframe/CSS/assets still behind Chrome (separate gaps).

---

## Lessons Learned

- When relocating prototype properties for fingerprint parity, never use `in` to test destination ownership — it follows the prototype chain and causes silent deletion.
- Third-party widgets (reCAPTCHA, Turnstile) depend on basic DOM geometry APIs (`element.style`, `offsetWidth`); missing `style` fails late with obscure minified stack traces.
- Compare sorry-page **DOM probes** (`cfgClients`, iframe count) early — network-only analysis showed scripts loaded but not that render failed.

---

## References

- [HTMLElement.style — MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/style)
- Google sorry page loads `/recaptcha/enterprise.js` which dynamically inserts `recaptcha__en.js` and calls `grecaptcha.enterprise.render` on `window` `load` / `complete`.
- Tooling: `npm run google:sorry-parity`, `google-search-debug/scripts/probe-sorry-grecaptcha.mjs`

---

## Related Knowledge

- [Google Search knitsail window-keys prune](./2026-06-29-google-search-knitsail-window-keys-prune.md)
- [Google Search signal inventory](../captcha/detection/google-search-signal-inventory.md)