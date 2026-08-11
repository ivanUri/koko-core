# CreepJS `cssMedia` Section Parity (Verified)

## Summary

Koko matches Chrome on the full CreepJS **`cssMedia`** fingerprint section: **0 field-level diffs** and identical section hash in `scripts/cdp-creepjs-section-compare.mjs`. The fix stack combined **CSS custom-property tokenization**, **owner-frame style routing** for phantom iframes, **`@media` text parsing** in `StyleManager`, and two **macOS Chrome media semantics** (`inverted-colors` unsupported, `color-gamut: srgb` on the probe machine).

`cssMedia` is one of the most integration-heavy CreepJS sections—it exercises tokenizer, stylesheet injection, `matchMedia`, `getComputedStyle`, and cross-document DOM in a single hash. Antidetect browsers with a working `matchMedia` mock but broken stylesheet application still fail here.

---

## Problem

CreepJS `cssMedia` hashes diverged with large field gaps:

| Area | Chrome | Koko (before) |
|------|--------|-----------------|
| `mediaCSS` | 14 populated custom properties | `{}` / all `undefined` |
| `screenQuery` | e.g. `{1920, 1080}` or `{1680, 1050}` per display | `{0, 0}` |
| `matchMediaCSS.inverted-colors` | `undefined` | `"none"` |
| `matchMediaCSS.color-gamut` | `"srgb"` | `"p3"` |

`lies` gate stayed at **0**; failure was **semantic**, not lie-detection.

---

## Root Cause

Multiple independent gaps stacked:

### 1. Tokenizer — dashed-ident custom properties

`--*` names in `<style>` blocks were not tokenized as `<dashed-ident>`, so declarations never entered `StyleManager.custom_props`. See [CSS dashed-ident tokenizer bug](../../bugs/2026-06-29-css-dashed-ident-tokenizer.md).

### 2. Frame routing — caller vs owner

CreepJS `getCSSMedia()` injects styles into **phantom iframe** `document.body` but calls unqualified `getComputedStyle(body)` from the **parent** realm. Koko routed reads/writes through the **caller's** `Frame`, not the **element owner's** `Frame`. See [Owner frame cross-document styles](../../browser/iframe/owner-frame-cross-document-styles.md).

### 3. StyleManager.parseSheet — at-rules skipped

When `CSSStyleSheet.cssRules` existed (even empty), raw `<style>` text with `@media` blocks was never scanned. CreepJS injects **only** `@media` at-rules with custom properties on `body`—no regular rules.

### 4. inverted-colors on macOS Chrome

Koko matched `(inverted-colors: none)`; Chrome on macOS treats the media feature as **unsupported**—both `inverted` and `none` queries false → `matchMediaCSS.inverted-colors: undefined`.

### 5. color-gamut viewport default

Koko viewport defaulted to **p3** (profile wide-gamut display); the Chrome session used for compare reported **`srgb`** for `matchMediaCSS.color-gamut`.

### 6. Display geometry (harness)

`screenQuery` binary-search depends on injected `@media (device-width: Npx)` custom props **and** profile/Chrome `screen` alignment. Mismatch between 1680×1050 profile and 1920×1080 primary display causes false regression—see [1680 display probe](../creepjs-probe-1680-display.md).

---

## Investigation

### Probe commands (canonical)

```bash
cd /Users/huydev/Desktop/koko
zig build install
node scripts/cdp-section-field-compare.mjs cssMedia
node scripts/cdp-creepjs-section-compare.mjs \
  --profile chrome-local-huys-macbook-pro \
  --max-sec 20
```

Outputs:

- `code-check/tmp/section-field-compare-cssMedia.json`
- `code-check/tmp/creepjs-section-compare/`

### CreepJS algorithm (simplified)

From `code-check/sites/creep/creep.js` — `getCSSMedia()`, `getScreenMedia()`, `query()`:

1. Use `PHANTOM_DARKNESS` iframe `win.screen` for `device-aspect-ratio` / `device-screen` `matchMedia` checks.
2. Inject large `<style>` with `@media` rules setting `--prefers-*`, `--device-screen`, etc. on `body`.
3. Read `getComputedStyle(body)` custom properties → **`mediaCSS`**.
4. Binary-search screen dimensions via `@media (device-width: Npx)` custom props → **`screenQuery`**.

Koko had to support steps 2–4 on iframe `body` while step 3 often runs from parent global.

### Diagnostic pattern

When `matchMediaCSS` mostly matched but `mediaCSS` was empty:

- **Read path** (`getComputedStyle` frame) vs **write path** (`innerHTML` / stylesheet registration frame) diverged—classic owner-frame bug.

---

## Solution

| Change | File(s) | Why |
|--------|---------|-----|
| `<dashed-ident>` token | `src/core/css/Tokenizer.zig` | Parse `--*` declarations |
| Always parse `@media` text | `StyleManager.zig` | `cssRules` skips at-rules |
| `ownerFrame` for styles | `Element.zig`, `Style.zig`, `CSSStyleSheet.zig`, `CSSStyleDeclaration.zig` | Phantom iframe pattern |
| `inverted-colors` → never match | `MediaQueryEval.zig` | macOS Chrome behavior |
| `color_gamut: srgb` | `MediaQueryList.zig`, `StyleManager` viewport | Match probe machine Chrome |

### ownerFrame call sites (summary)

- `CSSStyleDeclaration.styleFrameFor` — custom `--*` reads use element's `StyleManager`
- `Element.setInnerHTML` — parse via `owner_frame`
- `HTMLStyleElement` sheet attach — register on owner document
- `CSSStyleSheet` mutations — `insertRule` / `replaceSync` notify owner

**Profile note:** For the verified compare session, screen profile matched **live Chrome on probe machine** (documented as 1920×1080 in one session; 1680×1050 when built-in primary—see display probe doc). Profile screen must match **the Chrome session used as reference**.

### End-to-end dependency graph

```
Tokenizer (--ident)
    → StyleManager.parseSheet (@media text)
        → HTMLStyleElement on owner document (ownerFrame)
            → custom_props on iframe body
                → getComputedStyle(body) via owner StyleManager
                    → mediaCSS + screenQuery hashes
```

A break at any layer presents differently in field compare:

| Failure layer | `matchMediaCSS` | `mediaCSS` | `screenQuery` |
|---------------|-----------------|------------|---------------|
| Tokenizer | OK | empty | `{0,0}` |
| ownerFrame write | OK | empty | wrong |
| ownerFrame read | partial | empty | partial |
| parseSheet @media | OK | empty | wrong |
| screen profile drift | partial | partial | wrong |

This table is the recommended first-pass triage for `cssMedia` regressions.

### Koko file index

| Subsystem | Primary Zig paths |
|-----------|-------------------|
| Tokenizer | `src/core/css/Tokenizer.zig` |
| StyleManager | style subsystem `StyleManager.zig` |
| Media eval | `MediaQueryEval.zig`, `MediaQueryList.zig` |
| DOM write | `Element.zig`, `Style.zig`, `CSSStyleSheet.zig` |
| DOM read | `CSSStyleDeclaration.zig` (`styleFrameFor`) |
| Frame link | `Node.zig` (`ownerFrame`), `Frame.zig` |

---

## Lessons Learned

- **Use field compare before chasing section hash** — lists exact keys (`mediaCSS.device-screen`, etc.).
- **`matchMediaCSS` and `mediaCSS` test different subsystems** — evaluator vs stylesheet custom properties; fix both.
- **CreepJS `screenQuery` depends on custom properties**, not only `screen.width`.
- **Profile screen dimensions must match Chrome reference session**, not an assumed monitor.
- **cssMedia is the canary for cross-document CSS** — fixes here prevent regressions in CreepJS phantom iframe and real sites using `contentDocument` + global APIs.

---

## References

- CreepJS: `code-check/sites/creep/creep.js` — `getCSSMedia()`, `getScreenMedia()`, `query()`
- [Media Queries Level 4 — `inverted-colors`](https://drafts.csswg.org/mediaqueries-5/#inverted)
- Koko probes: `scripts/cdp-section-field-compare.mjs`, `scripts/cdp-creepjs-section-compare.mjs`
- Tokenizer bug: `knowledge/bugs/2026-06-29-css-dashed-ident-tokenizer.md`
- Owner frame: `knowledge/browser/iframe/owner-frame-cross-document-styles.md`

---

## Related Knowledge

- [CSS dashed-ident tokenizer bug](../../bugs/2026-06-29-css-dashed-ident-tokenizer.md)
- [Owner frame cross-document styles](../../browser/iframe/owner-frame-cross-document-styles.md)
- [CreepJS probe 1680×1050 display](../creepjs-probe-1680-display.md)
- [Window `getOwnPropertyNames` hook](../navigator/window-features-opn-hook.md) — same phantom iframe harness