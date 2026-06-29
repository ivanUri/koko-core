# Owner Frame Resolution for Cross-Document Style Operations

## Summary

CreepJS runs many CSS probes inside a nested phantom `<iframe>` but calls unqualified `getComputedStyle(body)` from the main window realm. Velora routed style operations through the **caller's** `Frame` instead of the **element owner's** `Frame`, so custom properties and stylesheets landed on the main document while reads targeted the iframe `body`. Fixing `Node.ownerFrame()` usage across `innerHTML`, `<style>` sheet registration, and `getComputedStyle` was required for correct behavior even after custom-property tokenization was fixed.

---

## Problem

With dashed-ident tokenization fixed, same-document custom property probes passed, but CreepJS `cssMedia` could still fail when:

- `PHANTOM_DARKNESS.document.body.innerHTML = '<style>…@media…</style>'` ran from code executing in the **parent** realm
- `getComputedStyle(body)` was invoked as a global function (incumbent `Window` = parent)

Symptoms before the full fix set:

- Stylesheet count in the iframe looked correct from JS
- Custom property reads on iframe `body` still empty
- `StyleManager.custom_props` keyed on the wrong `body` element

---

## Root Cause

In the Web platform, a `Node` belongs to a specific `Document`, which belongs to a specific browsing context (`Frame`). Operations that mutate or query **tree-local state** (stylesheets, custom properties, layout caches) must use that document's frame.

Velora had several call sites that always used the `Frame` passed from the currently executing JavaScript context:

| Operation | Wrong frame used | Effect |
|-----------|------------------|--------|
| `Element.setInnerHTML` | Caller frame | Parser callbacks / `StyleManager` on parent |
| `HTMLStyleElement` sheet attach | Caller frame | Sheet in parent `document.styleSheets` |
| `getComputedStyle(el)` | Caller frame | Reads parent `StyleManager` for iframe element |

`Node.ownerFrame(default)` already existed: walk `ownerDocument`, return `document._frame`. It was underused.

CreepJS is an extreme case of a common pattern: cross-document DOM writes + global API reads.

---

## Investigation

1. Traced CreepJS `getPhantomIframe()` → `getBehemothIframe()` → deeply nested `contentWindow`.
2. Noted `getCSSMedia()` calls bare `getComputedStyle(body)`, not `win.getComputedStyle(body)`.
3. Chrome resolves the element's document internally; Velora required explicit `ownerFrame`.
4. Confirmed `document._frame` is set in `Frame.init` for iframe `about:blank` documents.

---

## Solution

Route style-affecting work through `element.asNode().ownerFrame(caller)`:

1. **`CSSStyleDeclaration.styleFrameFor`** — `getPropertyValue` / custom `--*` reads use the element's frame `StyleManager`.
2. **`Element.setInnerHTML`** — parse and mutate via `owner_frame` (DOM churn, `nodeIsReady`, style callbacks).
3. **`HTMLStyleElement.getSheet` / `styleAddedCallback`** — register sheets on owner document; `sheetModified` on owner `StyleManager`.
4. **`CSSStyleSheet` mutations** — `insertRule` / `replaceSync` notify owner's `StyleManager`.

Together with `StyleManager.parseSheet` always parsing raw `<style>` text for `@media` blocks (because `cssRules` skips at-rules), iframe phantom probes match Chrome.

---

## Lessons Learned

- **Caller frame ≠ owner frame** whenever JS touches nodes across `contentDocument` / `contentWindow`.
- Fingerprint scripts often use globals intentionally; don't assume `getComputedStyle` is called on the same `Window` as the node's document.
- When `matchMedia` works but injected custom properties don't, check **write path** (which frame got `innerHTML` / stylesheet) separately from **read path** (`getComputedStyle` frame).
- `ownerFrame` should be the default for DOM tree services tied to a document (styles, hit testing, selection), not an iframe-only hack.

---

## References

- [HTML — `getComputedStyle(elt)`](https://html.spec.whatwg.org/#dom-window-getcomputedstyle) (element's styles come from its document)
- [DOM — node document](https://dom.spec.whatwg.org/#concept-node-document)
- CreepJS phantom iframe setup (`getPhantomIframe`, `getBehemothIframe`)
- Velora: `src/core/dom/Node.zig` (`ownerFrame`), `src/core/dom/Element.zig`, `src/core/webapi/css/CSSStyleDeclaration.zig`, `src/core/webapi/element/html/Style.zig`

---

## Related Knowledge

- [CSS dashed-ident tokenizer bug](../bugs/2026-06-29-css-dashed-ident-tokenizer.md)
- [CreepJS cssMedia parity](../fingerprint/css-media/creepjs-cssmedia-parity.md)