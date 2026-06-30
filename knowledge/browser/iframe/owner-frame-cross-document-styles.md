# Owner Frame Resolution for Cross-Document Style Operations

## Summary

CreepJS runs many CSS probes inside a **nested phantom `<iframe>`** but calls unqualified **`getComputedStyle(body)`** from the **main window** realm. Velora routed style operations through the **caller's** `Frame` instead of the **element owner's** `Frame`, so custom properties and stylesheets landed on the parent document while reads targeted the iframe `body`. Fixing **`Node.ownerFrame()`** usage across `innerHTML`, `<style>` sheet registration, and `getComputedStyle` was required for correct `cssMedia` parity—even after custom-property tokenization was fixed.

**Caller frame ≠ owner frame** is a recurring antidetect bug pattern: fingerprint scripts and ad iframes intentionally use globals and cross-document DOM writes. Engines must resolve the element's document internally, as Chrome does.

---

## Problem

With dashed-ident tokenization fixed, same-document custom property probes passed, but CreepJS **`cssMedia`** could still fail when:

- `PHANTOM_DARKNESS.document.body.innerHTML = '<style>…@media…</style>'` ran from code executing in the **parent** realm
- `getComputedStyle(body)` was invoked as a global function (incumbent `Window` = parent)

Symptoms before the full fix set:

| Observation | Misleading conclusion |
|-------------|----------------------|
| Stylesheet count in iframe looked correct from JS | “Sheet attached” ≠ “sheet on **this** document's StyleManager” |
| Custom property reads on iframe `body` empty | Tokenizer still broken (often false) |
| `StyleManager.custom_props` keyed on wrong `body` | Write path used parent frame |

`matchMediaCSS` could match while **`mediaCSS`** stayed `{}`—evaluator worked, stylesheet custom properties did not.

---

## Root Cause

In the Web platform, a `Node` belongs to a `Document`, which belongs to a browsing context (`Frame`). Operations that mutate or query **tree-local state** (stylesheets, custom properties, layout caches) must use that document's frame.

Velora had call sites using the `Frame` from the **currently executing JavaScript context**:

| Operation | Wrong frame used | Effect |
|-----------|------------------|--------|
| `Element.setInnerHTML` | Caller frame | Parser callbacks / `StyleManager` on parent |
| `HTMLStyleElement` sheet attach | Caller frame | Sheet in parent `document.styleSheets` |
| `getComputedStyle(el)` | Caller frame | Reads parent `StyleManager` for iframe element |

`Node.ownerFrame(default)` already existed in `src/core/dom/Node.zig`: walk `ownerDocument`, return `document._frame`. It was **underused**.

CreepJS is an extreme case of a common pattern: **cross-document DOM writes + global API reads**.

---

## Investigation

### CreepJS iframe chain

Traced in `code-check/sites/creep/creep.js`:

1. `getPhantomIframe()` → `getBehemothIframe()` → deeply nested `contentWindow`
2. `getCSSMedia()` sets `body.innerHTML` with `@media` rules on iframe document
3. Calls bare `getComputedStyle(body)` — **not** `win.getComputedStyle(body)`

Chrome resolves the element's document internally per [HTML `getComputedStyle(elt)`](https://html.spec.whatwg.org/#dom-window-getcomputedstyle). Velora required explicit **`ownerFrame`**.

### Frame linkage

Confirmed `document._frame` set in `Frame.init` for iframe `about:blank` documents—owner walk is reliable for phantom probes.

### Probes

```bash
cd /Users/huydev/Desktop/velora
node scripts/cdp-section-field-compare.mjs cssMedia
node scripts/cdp-creepjs-section-compare.mjs \
  --profile chrome-local-huys-macbook-pro \
  --max-sec 20
```

Field compare showed all `mediaCSS.*` `undefined` while `matchMediaCSS.*` mostly matched—classic read/write frame split.

---

## Solution

Route style-affecting work through **`element.asNode().ownerFrame(caller)`**:

### 1. CSSStyleDeclaration.styleFrameFor

`getPropertyValue` / custom `--*` reads use the element's frame **`StyleManager`**.

**File:** `src/core/webapi/css/CSSStyleDeclaration.zig`

### 2. Element.setInnerHTML

Parse and mutate via **`owner_frame`** (DOM churn, `nodeIsReady`, style callbacks).

**File:** `src/core/dom/Element.zig`

### 3. HTMLStyleElement sheet lifecycle

`getSheet` / `styleAddedCallback` register sheets on **owner document**; `sheetModified` on owner `StyleManager`.

**File:** `src/core/webapi/element/html/Style.zig`

### 4. CSSStyleSheet mutations

`insertRule` / `replaceSync` notify **owner's** `StyleManager`.

**File:** `src/core/webapi/css/CSSStyleSheet.zig`

### 5. StyleManager.parseSheet

Always parse raw `<style>` text for `@media` blocks when CreepJS injects at-rules only—`cssRules` iteration skips at-rules.

**File:** `StyleManager.zig` (style subsystem)

Together with dashed-ident tokenization (`knowledge/bugs/2026-06-29-css-dashed-ident-tokenizer.md`), iframe phantom probes match Chrome. Documented outcome: [CreepJS cssMedia parity](../../fingerprint/css-media/creepjs-cssmedia-parity.md).

### Chrome vs Velora mental model

In Chromium, `getComputedStyle(element)` is implemented in C++ with direct access to the element's `Document` and `ComputedStyle`. The incumbent JavaScript `Window` is not consulted for style storage lookup. Velora's explicit `ownerFrame` parameter recreates that invariant in a multi-frame Zig runtime where `StyleManager` is per-`Frame`, not global.

Without `ownerFrame`, symptoms can look like “CSS parser bugs” or “custom properties unsupported” because reads hit an empty `custom_props` map on the parent document's `body`—while writes appeared to succeed when inspected via the wrong frame's DevTools view.

### Other APIs to audit with ownerFrame

Any DOM service keyed by document should default to owner frame, not caller:

| API | Risk if caller-bound |
|-----|----------------------|
| `element.offsetWidth` / layout | Wrong layout tree |
| `document.styleSheets` | Parent sheet list |
| `matchMedia` tied to viewport | Less common cross-frame, but iframe `screen` matters for CreepJS |
| `getSelection()` | Wrong document selection |

Velora fixed the style-critical path first because CreepJS `cssMedia` failed loudly; layout parity sections may need the same audit over time.

### reCAPTCHA and enterprise scripts

Cross-frame DOM is not unique to CreepJS. reCAPTCHA injects into nested iframes and sets inline styles on wrapper elements (`knowledge/bugs/2026-06-29-grecaptcha-htmlelement-style-shim.md`). Owner-frame correctness for `innerHTML` and `getComputedStyle` reduces whole classes of “widget never renders” failures on flagged IPs.

---

## Lessons Learned

- **Caller frame ≠ owner frame** whenever JS touches nodes across `contentDocument` / `contentWindow`.
- **Fingerprint scripts use globals intentionally**; do not assume `getComputedStyle` is called on the same `Window` as the node's document.
- **When `matchMedia` works but injected custom properties don't**, check **write path** (`innerHTML` / stylesheet frame) separately from **read path** (`getComputedStyle` frame).
- **`ownerFrame` should be the default** for DOM tree services tied to a document (styles, hit testing, selection)—not an iframe-only hack.
- **Antidetect validation must include iframe-heavy collectors** (CreepJS, reCAPTCHA) — top-level-only tests miss this class of bug.

---

## References

- [HTML — `getComputedStyle(elt)`](https://html.spec.whatwg.org/#dom-window-getcomputedstyle)
- [DOM — node document](https://dom.spec.whatwg.org/#concept-node-document)
- CreepJS: `getPhantomIframe`, `getBehemothIframe`, `getCSSMedia()` in `code-check/sites/creep/creep.js`
- Velora: `src/core/dom/Node.zig` (`ownerFrame`), `Element.zig`, `CSSStyleDeclaration.zig`, `Style.zig`
- Probes: `scripts/cdp-section-field-compare.mjs cssMedia`, `scripts/cdp-creepjs-section-compare.mjs`

---

## Related Knowledge

- [CSS dashed-ident tokenizer bug](../../bugs/2026-06-29-css-dashed-ident-tokenizer.md) — prerequisite for custom properties in `<style>`
- [CreepJS cssMedia parity](../../fingerprint/css-media/creepjs-cssmedia-parity.md) — verified section outcome
- [CreepJS css parity](../../fingerprint/css/creepjs-css-parity.md) — computed style enumeration (same-origin reads)
- [Window `getOwnPropertyNames` hook](../../fingerprint/navigator/window-features-opn-hook.md) — phantom iframe enumeration context