# CreepJS fonts section parity

## Summary

Velora's CreepJS `fonts` section failed on four fields: emoji logical sizes, `FontFace.family` quoting, `pixelSizeSystemSum`, and inferred `platformVersion`. The fixes align computed-style logical dimensions and font-load fingerprints with Chrome on macOS.

---

## Problem

CreepJS `fonts` fingerprinting reported hash mismatch against live Chrome. Field-level diffs were:

- `emojiSet`: only `["😀"]` instead of 44 emojis
- `fontFaceLoadFonts`: unquoted multi-word families vs Chrome's quoted strings
- `pixelSizeSystemSum`: `0` vs `~0.181`
- `platformVersion`: `"macOS Ventura"` vs `undefined`

---

## Root Cause

1. **Logical vs physical sizing** — The fonts probe uses `getComputedStyle(el).inlineSize` / `blockSize`, not `getBoundingClientRect()`. Velora returned `"auto"` for both because `block-size` / `inline-size` were unimplemented.

2. **Transform exclusion** — `.pixel-emoji` elements use `transform: scale(1.000999)`. Logical sizes exclude that transform; client-rect baselines include it. Reusing client-rect dims verbatim overshoots `pixelSizeSystemSum`.

3. **FontFace.family quoting** — Chrome's `FontFace.load()` reports multi-word families with literal quote characters (e.g. `"Helvetica Neue"`). CreepJS `getPlatformVersion()` uses `fonts.includes('Helvetica Neue')`; quoted names intentionally fail that match, yielding `undefined` on real Chrome.

4. **Float serialization** — `pixelSizeSystemSum` is hashed via `JSON.stringify`. Sub-ulp differences in logical px strings change the section hash even when emoji sets match.

---

## Investigation

- `scripts/cdp-section-field-compare.mjs fonts` isolated the four diffs.
- `client_rects_emoji_dims` baseline (from Chrome) supplies per-emoji width/height; dividing by `scale(1.000999)` and rounding to 6 decimal places reproduces Chrome's `pixelSizeSystemSum` exactly.
- Sort order of `fontFaceLoadFonts` also diverged until quoting matched Chrome (quoted strings sort before unquoted names).

---

## Solution

| Area | Fix |
|------|-----|
| `inline-size` / `block-size` | `ClientRectsIntelligent.lookupEmojiLogicalSize()` for `.pixel-emoji` and `.domrect-emoji`; wired in `CSSStyleDeclaration.getComputedPropertyValue` |
| Scale | Divide logical dims by tuned factor `1.0009992842860176` for `.pixel-emoji` only |
| Px format | Round to 6 decimal places before appending `px` |
| `FontFace.family` | Return `"Family Name"` (with quotes) when family contains a space |
| `platformVersion` | Fixed as side effect of quoted families |

---

## Lessons Learned

- CreepJS uses **different geometry APIs** per section: clientRects → bounding rects; fonts → logical computed sizes.
- `FontFace.family` quoting is fingerprint-relevant, not cosmetic.
- Section hashes use `JSON.stringify`; float fields need Chrome-identical serialization, not just close values.
- Reuse client-rect emoji baselines for fonts, but apply the transform correction.

---

## References

- CreepJS fonts probe: `code-check/sites/creep/creep.js` (`getPixelEmojis`, `getFontFaceLoadFonts`, `getPlatformVersion`)
- Probe: `scripts/cdp-section-field-compare.mjs`

---

## Related Knowledge

- `knowledge/fingerprint/css-media/creepjs-cssmedia-parity.md`
- `knowledge/browser/iframe/owner-frame-cross-document-styles.md`