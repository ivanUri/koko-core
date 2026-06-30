# CSS Custom Property Names Were Not Tokenized (`<dashed-ident>`)

> **Phase 1** stylesheet pipeline fix in [`google-search-investigation-journey.md`](../captcha/detection/google-search-investigation-journey.md). Unblocks [`creepjs-cssmedia-parity.md`](../fingerprint/css-media/creepjs-cssmedia-parity.md) and [`svg + cssMedia baseline refresh`](./2026-06-29-creepjs-svg-cssmedia-baseline-refresh.md).

## Summary

CreepJS `cssMedia` reported an empty `mediaCSS` object and `screenQuery` of `{0,0}` because Velora's CSS tokenizer split `--custom-property` into two `-` delimiter tokens plus a separate identifier instead of a single `<dashed-ident>` token. Declaration parsing never recognized custom property names, so `@media` rules could not inject `--prefers-*` variables onto `body`, and `getComputedStyle(body).getPropertyValue('--…')` always returned empty. `matchMedia()` results were mostly correct — a misleading split that sent investigation toward viewport math and iframe routing before the upstream tokenizer bug was found. Fix: extend the `-` branch in `Tokenizer.zig` to consume full `--ident` sequences per CSS Syntax Level 3.

---

## Problem

After wiring `StyleManager` to collect custom properties from matching `@media` blocks, CreepJS `cssMedia` still showed:

| Field | Chrome | Velora (before) |
|-------|--------|-----------------|
| `mediaCSS.*` | 14 populated custom properties | all `undefined` |
| `screenQuery` | `{ width: 1920, height: 1080 }` (machine-dependent) | `{0, 0}` |
| `matchMediaCSS.*` | populated | mostly **correct** |

The asymmetry was the diagnostic clue: **media query evaluation worked**; **stylesheet declaration ingestion did not**.

### Browser architecture context

Modern CSS fingerprinting (CreepJS `getCSSMedia()`) uses a hybrid of two subsystems:

1. **`matchMedia()` / `MediaQueryList`** — evaluates predicate expressions against the viewport and device environment.
2. **Author stylesheet custom properties** — injects `--prefers-color-scheme`, `--device-screen`, etc. onto `body` inside `@media` blocks, then reads them via `getComputedStyle(body).getPropertyValue('--…')`.

Velora had invested in (1) via `MediaQueryEval.zig` and `MediaQueryList.zig`. Section hash still failed because (2) never stored declarations — the tokenizer → parser → `StyleManager.addCustomProps` pipeline dropped `--*` names at the first stage.

This is analogous to a JavaScript engine parsing `function` correctly but failing on `async function` — the evaluator works, but source text never becomes storable semantics.

---

## Root Cause

Per [CSS Syntax Level 3 `<dashed-ident>`](https://drafts.csswg.org/css-syntax/#typedef-dashed-ident), a custom property name is:

- Two leading hyphens (`--`)
- Followed by a valid identifier start and continuation (`foo-bar` → full token `--foo-bar`)

Per [CSS Variables Level 1](https://drafts.csswg.org/css-variables/#typedef-custom-property-name), property names matching `<dashed-ident>` are custom properties stored verbatim (case-sensitive) and resolved at computed-value time.

### Velora tokenizer (before fix)

A lone `-` in the input stream was handled as:

1. Emit `<delim-token>` `-`
2. Peek next `-` → emit second `<delim-token>` `-`
3. Emit `<ident-token> foo-bar` for remainder

The declaration parser (`DeclarationsIterator`) only accepts a **single `.ident` token** as property name. It never assembled `--foo-bar` from three tokens, so declarations like:

```css
@media (prefers-color-scheme: dark) {
  body { --prefers-color-scheme: dark }
}
```

were **silently skipped** as invalid property names. The `@media` prelude could match (media evaluation path), but the inner block produced **zero** storable declarations.

### Why `screenQuery` was `{0,0}`

CreepJS binary-searches screen dimensions by injecting `@media (device-width: Npx) { body { --device-width: … } }` and reading custom properties. With all `--*` declarations dropped, the search never found a match — defaulting to zero dimensions.

### Independence from iframe routing

Initial suspicion: phantom iframe `ownerFrame` mismatch (see [owner-frame note](../browser/iframe/owner-frame-cross-document-styles.md)). Minimal `about:blank` probe on **main document** still failed until tokenization was fixed — proving tokenizer bug was necessary and upstream.

---

## Investigation

### Step 1 — Field compare

```bash
cd /Users/huydev/Desktop/velora
node scripts/cdp-section-field-compare.mjs cssMedia
```

Listed all `mediaCSS.*` as `undefined` while `matchMediaCSS.*` mostly matched Chrome.

### Step 2 — Minimal CDP probe (`about:blank`)

```javascript
document.body.innerHTML = '<style>@media all { body { --test-prop: ok } }</style>';
getComputedStyle(document.body).getPropertyValue('--test-prop');  // "" before fix
document.styleSheets[0].cssRules.length;  // 0 — @media not in cssRules (expected)
matchMedia('(prefers-color-scheme: dark)').matches;  // true
```

Confirmed: evaluation OK, custom property injection broken.

### Step 3 — Rule out cross-iframe issues

Same probe on main frame failed — not iframe-specific.

### Step 4 — Trace tokenizer output

Stepped `DeclarationsIterator` — only handles `.ident` name tokens. Logged tokenizer emission for `--prefers-color-scheme`:

```
// Before: .delim('-'), .delim('-'), .ident('prefers-color-scheme')
// After:  .ident('--prefers-color-scheme')
```

### Step 5 — CreepJS algorithm read

`getCSSMedia()` in `code-check/sites/creep/creep.js` injects large `<style>` with `@media` blocks setting `--*` on `body` — no `cssRules` API dependency for injection path; relies on `StyleManager` text parse.

---

## Solution

Extend the `-` branch in `src/core/browser/css/Tokenizer.zig`:

- When input is `--` followed by a valid identifier start, consume the full `<dashed-ident>` and emit one `.ident` token (e.g. `--prefers-color-scheme`).
- Preserve existing behavior for:
  - Numeric negatives (`-3px`)
  - `-->` CDC token
  - Single `-` as delimiter in other contexts

After fix:

1. `parseDeclarationsList` recognizes custom properties.
2. `StyleManager.addCustomProps` stores them on `body` when `@media` matches.
3. `getComputedStyle` returns injected values for CreepJS probes.

### Verification

```bash
# Minimal probe (CDP or script)
# getComputedStyle(body).getPropertyValue('--test-prop') → "ok"

node scripts/cdp-section-field-compare.mjs cssMedia
node scripts/cdp-creepjs-section-compare.mjs \
  --profile chrome-local-huys-macbook-pro --sections cssMedia
```

**Pass:** `mediaCSS` populated; `screenQuery` non-zero; **0 field diffs** on `cssMedia` (combined with owner-frame + gamut fixes in [cssMedia parity doc](../fingerprint/css-media/creepjs-cssmedia-parity.md)).

### Related pipeline fixes (same section, different layers)

| Layer | Fix | Doc |
|-------|-----|-----|
| Tokenizer | `<dashed-ident>` | this note |
| StyleManager | Always parse `@media` text | cssMedia parity |
| Element routing | `ownerFrame` for iframe body | owner-frame note |
| Media eval | `inverted-colors`, `color-gamut` | baseline refresh note |

---

## Lessons Learned

1. **Empty `mediaCSS` with working `matchMedia` → stylesheet-to-computed-style gap**, not bad viewport math.
2. **Custom-property probes depend on tokenization + declaration parsing**, not just `@media` evaluation.
3. **Always test with one-line `about:blank` probe** before chasing iframe phantom-window theories.
4. **`CSSStyleSheet.cssRules` intentionally omits `@media`** in many paths; CreepJS custom props flow through raw `<style>` text parsing in `StyleManager`.
5. **CSS tokenizer bugs cascade silently** — invalid declarations are skipped, not errors; fingerprints show `undefined`, not parse exceptions.
6. **Read CSS Syntax, not just Variables spec** — custom property *names* are tokenization concerns; *values* are cascade concerns.

---

## References

- [CSS Variables Level 1 — custom property name syntax](https://drafts.csswg.org/css-variables/#typedef-custom-property-name)
- [CSS Syntax Module Level 3 — `<dashed-ident>`](https://drafts.csswg.org/css-syntax/#typedef-dashed-ident)
- [CSS Syntax — tokenization of `-`](https://drafts.csswg.org/css-syntax/#tokenizer-diagram)
- CreepJS `getCSSMedia()` — `code-check/sites/creep/creep.js`
- Velora: `src/core/browser/css/Tokenizer.zig`
- Velora: `src/core/browser/StyleManager.zig`
- Velora: `src/core/webapi/css/CSSStyleDeclaration.zig`
- WPT analog: `css/css-syntax/tokenization/` (dashed-ident consumer tests in supporting browsers)

---

## Related Knowledge

- [CreepJS cssMedia parity](../fingerprint/css-media/creepjs-cssmedia-parity.md) — full section fix stack
- [Owner frame cross-document styles](../browser/iframe/owner-frame-cross-document-styles.md) — iframe phantom pattern (layer 2)
- [CreepJS svg + cssMedia baseline refresh](./2026-06-29-creepjs-svg-cssmedia-baseline-refresh.md) — `color-gamut: p3` follow-on
- [CreepJS CSS parity](../fingerprint/css/creepjs-css-parity.md) — broader stylesheet fingerprint context
- [Google Search investigation journey](../captcha/detection/google-search-investigation-journey.md) — Phase 1 fingerprint vs Search tier