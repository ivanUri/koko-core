# CSS Custom Property Names Were Not Tokenized (`<dashed-ident>`)

## Summary

CreepJS `cssMedia` reported an empty `mediaCSS` object and `screenQuery` of `{0,0}` because Velora's CSS tokenizer split `--custom-property` into two `-` delimiters instead of a single identifier. Declaration parsing never saw custom property names, so `@media` rules could not inject `--prefers-*` variables onto `body`, and `getComputedStyle(body).getPropertyValue('--…')` always returned empty.

---

## Problem

After wiring `StyleManager` to collect custom properties from matching `@media` blocks, CreepJS still showed:

- `mediaCSS`: every field `undefined` (Chrome had full values)
- `screenQuery`: `{ width: 0, height: 0 }` (Chrome had real screen dimensions)

`matchMedia()` results were mostly correct, which was misleading: media **evaluation** worked, but media **injection via custom properties** did not.

---

## Root Cause

Per [CSS Syntax Level 3](https://drafts.csswg.org/css-syntax/#typedef-dashed-ident), a custom property name is a **`<dashed-ident>`**: two leading hyphens followed by a valid identifier (`--foo-bar`).

Velora's tokenizer handled a lone `-` like this:

1. Emit `<delim-token> -`
2. Emit another `<delim-token> -`
3. Emit `<ident-token> foo-bar` for the remainder

The declaration parser only accepts `.ident` as a property name. It never assembled `--foo-bar`, so declarations inside rules like:

```css
body { --prefers-color-scheme: dark }
```

were skipped as invalid. The `@media` wrapper could match, but the inner block produced **zero** storable declarations.

This is independent of whether `getComputedStyle` uses the correct browsing context — even same-document probes failed until tokenization was fixed.

---

## Investigation

1. **Field compare** (`scripts/cdp-section-field-compare.mjs cssMedia`) listed all `mediaCSS.*` as `undefined` while `matchMediaCSS.*` mostly matched Chrome.

2. **Minimal CDP probe** on `about:blank`:
   - `body.innerHTML = '<style>@media all { body { --test-prop: ok } }</style>'`
   - `getComputedStyle(body).getPropertyValue('--test-prop')` → `""`
   - `document.styleSheets[0].cssRules.length` → `0` (expected: `@media` not in `cssRules`)
   - `matchMedia('(prefers-color-scheme: dark)').matches` → `true`

3. **Ruled out** cross-iframe `ownerFrame` issues first (still failed on main document).

4. **Confirmed** `DeclarationsIterator` only handles `.ident` name tokens — traced back to tokenizer output for `--`.

---

## Solution

Extend the `-` branch in `src/core/browser/css/Tokenizer.zig`:

- When input is `--` followed by a valid identifier start, consume the full `<dashed-ident>` and emit one `.ident` token (e.g. `--prefers-color-scheme`).
- Preserve existing behavior for numeric negatives, `-->` CDC token, and single `-` delimiters.

After this change, `parseDeclarationsList` recognizes custom properties, `StyleManager.addCustomProps` stores them on `body`, and `getComputedStyle` returns values injected by CreepJS-style `@media` probes.

**Verification:** same CDP probe returns `mainV: "dark-ok"`; CreepJS `cssMedia` field compare → **0 diffs**.

---

## Lessons Learned

- Empty `mediaCSS` with working `matchMedia` strongly suggests a **stylesheet → computed style** gap, not bad viewport math.
- Custom-property probes depend on **tokenization + declaration parsing**, not just `@media` evaluation.
- Always test with a one-line `about:blank` probe before chasing iframe phantom-window theories.
- `CSSStyleSheet.cssRules` intentionally skips `@media`; custom props for CreepJS must flow through raw `<style>` text parsing in `StyleManager`.

---

## References

- [CSS Variables Level 1 — custom property name syntax](https://drafts.csswg.org/css-variables/#typedef-custom-property-name)
- [CSS Syntax — dashed-ident](https://drafts.csswg.org/css-syntax/#typedef-dashed-ident)
- CreepJS `getCSSMedia()` in `code-check/sites/creep/creep.js` (injects `@media` blocks setting `--*` on `body`)
- Velora: `src/core/browser/css/Tokenizer.zig`, `src/core/browser/StyleManager.zig`, `src/core/webapi/css/CSSStyleDeclaration.zig`

---

## Related Knowledge

- [Owner Frame for Cross-Document Styles](../browser/iframe/owner-frame-cross-document-styles.md)
- [CreepJS cssMedia Parity](../fingerprint/css-media/creepjs-cssmedia-parity.md)