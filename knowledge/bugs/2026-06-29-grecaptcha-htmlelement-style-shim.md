# grecaptcha Fails to Mount on Google /sorry — HTMLElement.style Deleted by Compat Shim

> **Phase 4** sorry-page parity work in [`google-search-investigation-journey.md`](../captcha/detection/google-search-investigation-journey.md). Downstream of Search tier/bootstrap; blocks captcha UX even when network loads `enterprise.js`.

## Summary

On flagged Google Search IPs, Koko loaded `enterprise.js` and `recaptcha__en.js` successfully but never rendered the reCAPTCHA widget: `cfgClients=0`, empty `#recaptcha` div, no anchor iframe. Root cause was `element.style` returning `undefined` because `creepjs_compat_shim.js` deleted `style` (and `dataset`, `offsetWidth`, …) from `Element.prototype` without copying them to `HTMLElement.prototype`. reCAPTCHA's `render()` path assigns inline styles on wrapper elements (`element.style.width`, `element.style.height`); without a `CSSStyleDeclaration`, render throws before iframe creation. The scripts ran; layout crashed late with minified stack traces. Fix: correct shim guard to use `hasOwnProperty` instead of `in`, plus spec-correct `HTMLElement` IDL members delegating to `Element` helpers.

---

## Problem

Sorry-page parity compare (`npm run google:sorry-parity`) showed Koko and Chrome diverged on DOM outcome despite similar script network activity:

| Signal | Chrome | Koko (before) |
|--------|--------|-----------------|
| `cfgClients` | 1 | 0 |
| `hasRecaptchaIframe` | true | false |
| recaptcha network hits | 9 | 2 |
| `div.style` on fresh element | `CSSStyleDeclaration` | **undefined** |

Manual CDP probe on live Koko sorry session:

```javascript
grecaptcha.enterprise.render('recaptcha')
// TypeError: Cannot read properties of undefined (reading 'width')

document.createElement('div').style  // undefined
```

From a browser architecture standpoint, reCAPTCHA Enterprise follows a standard **DOM construction → inline style assignment → iframe insertion** pipeline. The widget does not use shadow DOM for its anchor frame in the enterprise flow we tested; it depends on ordinary `HTMLElement` geometry and style APIs. Koko's Web API layer exposed `Element.prototype.style` correctly at snapshot time, but a **prototype relocation shim** for CreepJS parity destroyed the property before third-party code could use it.

This was not a timing/`window.load` race, `crossOrigin` policy block, or `recaptcha__en.js` eval failure. Network analysis alone was misleading — scripts loaded, but render aborted silently until we probed `createElement('div').style`.

---

## Root Cause

### Prototype chain layout in browsers

In Chromium, several IDL members live on `HTMLElement.prototype` even though conceptually they are "element" APIs: `style`, `dataset`, `offsetWidth`, `offsetHeight`, `offsetTop`, `offsetLeft`. CreepJS `getPrototypeLies` compares prototype descriptor shapes between engines. Koko's antidetect stack mirrors Chrome layout by **moving** certain accessors from `Element.prototype` to `HTMLElement.prototype` at context initialization.

### The shim bug

At context init, `creepjs_compat_shim.js` runs a move loop:

1. Read descriptor from `Element.prototype` for each key in the move list (`style`, `dataset`, offset* …).
2. If key is not already on `HTMLElement.prototype`, define it there.
3. If configurable, `delete Element.prototype[key]`.

The guard used **`key in HTMLElement.prototype`**, which returns **true for inherited** properties on `Element.prototype`. The shim therefore **skipped** `Object.defineProperty(HTMLElement.prototype, key, desc)` but still executed `delete Element.prototype[key]` when configurable.

Result: `style`, `dataset`, `offsetWidth`, `offsetHeight`, etc. vanished from the entire prototype chain accessible to `HTMLDivElement` instances.

### Why reCAPTCHA failed specifically

`grecaptcha.enterprise.render()` creates DOM nodes and immediately sets:

```javascript
wrapper.style.width = '304px';
wrapper.style.height = '78px';
// ... additional layout properties
```

With `style === undefined`, the minified bundle throws `Cannot read properties of undefined (reading 'width')`. `cfgClients` stays 0 because no client instance registers. No anchor iframe is inserted; network stops after initial script fetches.

`clientWidth` and other properties that remained on `Element.prototype` still worked — the failure mode was specific to moved-then-deleted members.

---

## Investigation

### Step 1 — Sorry parity baseline

```bash
cd /Users/huydev/Desktop/koko
npm run google:sorry-parity -- --query "test-$(date +%s)"
```

Confirmed `cfgClients=0` vs Chrome `1`, `hasRecaptchaIframe=false`.

### Step 2 — Live CDP stack trace

`Runtime.evaluate` on Koko sorry session:

```javascript
grecaptcha.enterprise.render('recaptcha')
```

Stack pointed at `recaptcha__en.js` reading `.width` on undefined — not at script load or API key validation.

### Step 3 — Prototype descriptor audit

On fresh Koko context:

```javascript
Object.getOwnPropertyDescriptor(Element.prototype, 'style')      // null
Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style')  // null
Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth') // getter (still present)
```

Both levels null for `style` — property deleted from chain without destination copy.

### Step 4 — Shim source trace

Traced `creepjs_compat_shim.js` move loop — `in` operator vs `Object.prototype.hasOwnProperty.call(HTMLElement.prototype, key)`.

### Step 5 — Ruled out

| Hypothesis | Evidence |
|------------|----------|
| `window.load` timing | Manual `render()` after complete still fails |
| CSP blocking eval | `recaptcha__en.js` executes; error is post-eval DOM |
| Missing `grecaptcha` API | `grecaptcha.enterprise` object present |
| iframe sandbox | failure before any iframe creation |

### Verification commands

```bash
# Start koko with warmed profile, navigate to /sorry page via CDP
node scripts/cdp-profile-probe.mjs --profile chrome-local-huys-macbook-pro --max-sec 20
```

---

## Solution

Two changes (belt and suspenders):

### 1. Fix shim guard (`src/core/js/creepjs_compat_shim.js`)

Use `Object.prototype.hasOwnProperty.call(HTMLElement.prototype, key)` before define/delete, so inherited Element accessors are actually copied to `HTMLElement` before removal from `Element`.

### 2. Spec-correct HTMLElement IDL (`src/core/webapi/element/Html.zig`)

Add `style`, `dataset`, `offsetTop`, `offsetLeft`, `offsetWidth`, `offsetHeight` on `HTMLElement.JsApi`, delegating to existing `Element` helper implementations. Even if shim order changes, `HTMLElement` instances retain required APIs.

### After fix

```
cfgClients: 1
hasRecaptchaIframe: true
recaptchaChildren: 1
div.style.width = '304px' // works
```

Sorry parity: recaptcha chain 2 → 6+ hits; anchor + webworker load. Remaining gaps (bframe/CSS/assets) are separate network/resource issues.

---

## Lessons Learned

1. **Never use `in` to test destination ownership when relocating prototype properties.** It follows the prototype chain and causes silent deletion — one of the most expensive antidetect bugs because symptoms surface in third-party minified code.
2. **Third-party widgets depend on basic DOM geometry APIs.** reCAPTCHA, Turnstile, hCaptcha all assume `element.style` and offset getters exist. Test `createElement('div').style` early on any new profile or shim change.
3. **Compare sorry-page DOM probes before network-only analysis.** `cfgClients` and iframe count reveal render failure; network hit count does not.
4. **CreepJS compat shims are production code paths**, not test-only overlays — they run at every context init in antidetect mode.
5. **Fingerprint parity and site compatibility share the same prototype objects.** A move for `getPrototypeLies` can break Google, Stripe, or any inline-style widget.

---

## References

- [HTMLElement.style — MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTMLElement/style)
- [HTML Living Standard — HTMLElement IDL](https://html.spec.whatwg.org/multipage/dom.html#htmlelement)
- Google sorry page loads `/recaptcha/enterprise.js` → dynamic `recaptcha__en.js` → `grecaptcha.enterprise.render` on `window` `load` / `complete`
- Koko: `src/core/js/creepjs_compat_shim.js`
- Koko: `src/core/webapi/element/Html.zig`, `Element.zig`
- Tooling: `scripts/cdp-profile-probe.mjs` (20s budget)

---

## Related Knowledge

- [Google Search investigation journey](../captcha/detection/google-search-investigation-journey.md) — Phase 4 sorry parity
- [Google Search investigation journey](../captcha/detection/google-search-investigation-journey.md) — long-path bootstrap context
- [CreepJS navigator parity](../fingerprint/navigator/creepjs-navigator-parity.md) — prototype lie detection context
- [Owner frame cross-document styles](../browser/iframe/owner-frame-cross-document-styles.md) — related Web API routing patterns