# CreepJS `cssMedia` Section Parity (Verified)

## Summary

Velora now matches Chrome on the full CreepJS `cssMedia` fingerprint section: **0 field-level diffs** and identical section hash in `scripts/cdp-creepjs-section-compare.mjs`. The fix combined CSS custom-property tokenization, owner-frame style routing, `@media` text parsing in `StyleManager`, and two Mac Chrome media semantics (`inverted-colors` unsupported, `color-gamut: srgb`).

---

## Problem

CreepJS `cssMedia` hashes diverged with large field gaps:

| Area | Chrome | Velora (before) |
|------|--------|-----------------|
| `mediaCSS` | 14 populated fields | `{}` / all `undefined` |
| `screenQuery` | e.g. `{1920, 1080}` | `{0, 0}` |
| `matchMediaCSS.inverted-colors` | `undefined` | `"none"` |
| `matchMediaCSS.color-gamut` | `"srgb"` | `"p3"` |

`lies` gate stayed at 0; failure was semantic, not lie-detection.

---

## Root Cause

Multiple independent gaps stacked:

1. **Tokenizer** — `--*` names not parsed (see dashed-ident bug note).
2. **Frame routing** — phantom iframe `body` styled in one context, read in another (see owner-frame note).
3. **`StyleManager.parseSheet`** — when `CSSStyleSheet.cssRules` existed (even empty), raw `<style>` text with `@media` was never scanned; CreepJS only injects at-rules.
4. **`inverted-colors`** — Velora matched `(inverted-colors: none)` on macOS; Chrome treats the feature as unsupported (both queries false).
5. **`color-gamut`** — viewport defaulted to `p3`; this Mac Chrome session reported `srgb`.

---

## Investigation

**Probe commands** (canonical repo, 20s budget):

```bash
cd /Users/huydev/Desktop/velora
node scripts/cdp-section-field-compare.mjs cssMedia
node scripts/cdp-creepjs-section-compare.mjs --profile chrome-local-huys-macbook-pro --max-sec 20
```

**CreepJS algorithm (simplified):**

1. Use `PHANTOM_DARKNESS` iframe `win.screen` for `device-aspect-ratio` / `device-screen` matchMedia checks.
2. Inject a large `<style>` with `@media` rules setting `--prefers-*`, `--device-screen`, etc. on `body`.
3. Read `getComputedStyle(body)` custom properties → `mediaCSS`.
4. Binary-search screen dimensions via `@media (device-width: Npx)` custom props → `screenQuery`.

Velora had to support steps 2–4 on the iframe `body` while step 3 often runs from the parent global.

---

## Solution

| Change | File(s) | Why |
|--------|---------|-----|
| `<dashed-ident>` token | `css/Tokenizer.zig` | Parse `--*` declarations |
| Always parse `@media` text | `StyleManager.zig` | `cssRules` skips at-rules |
| `ownerFrame` for styles | `Element.zig`, `Style.zig`, `CSSStyleSheet.zig`, `CSSStyleDeclaration.zig` | iframe phantom pattern |
| `inverted-colors` → never match | `MediaQueryEval.zig` | macOS Chrome behavior |
| `color_gamut: srgb` | `MediaQueryList.zig`, `StyleManager` viewport | Match probe machine |

**Not changed for this section:** screen profile stayed **1920×1080** (live Chrome on probe machine; 1680×1050 profile caused `screen` regression).

---

## Lessons Learned

- Use **field compare** before chasing section hash — lists exact keys (`mediaCSS.device-screen`, etc.).
- `matchMediaCSS` and `mediaCSS` test different subsystems (evaluator vs stylesheet custom props).
- CreepJS `screenQuery` depends on custom properties too, not only `screen.width`.
- Profile screen dimensions must match **the Chrome session used as reference**, not an assumed monitor size.

---

## References

- CreepJS `getCSSMedia()`, `getScreenMedia()`, `query()` in `code-check/sites/creep/creep.js`
- [Media Queries Level 4 — `inverted-colors`](https://drafts.csswg.org/mediaqueries-5/#inverted)
- Velora probes: `scripts/cdp-section-field-compare.mjs`, `scripts/cdp-creepjs-section-compare.mjs`

---

## Related Knowledge

- [CSS dashed-ident tokenizer bug](../../bugs/2026-06-29-css-dashed-ident-tokenizer.md)
- [Owner frame cross-document styles](../../browser/iframe/owner-frame-cross-document-styles.md)