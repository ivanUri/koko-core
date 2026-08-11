# CreepJS `fonts` Section Parity

## Summary

Koko's CreepJS **`fonts`** section failed on four independent fields: **`emojiSet`** logical sizing, **`FontFace.family`** quoting, **`pixelSizeSystemSum`** float serialization, and inferred **`platformVersion`**. Fixes align computed-style logical dimensions, font-load fingerprints, and JSON hash inputs with Chrome 149 on macOS for profile `chrome-local-huys-macbook-pro`.

Unlike **`clientRects`**, which uses `getBoundingClientRect()`, CreepJS **`fonts`** probes **`getComputedStyle(el).inlineSize` / `blockSize`** on `.pixel-emoji` elements. Antidetect engines that only implement geometry APIs for one section will pass client rects and fail fonts—a common gap in forked Chromium patches.

---

## Problem

Field compare (`scripts/cdp-section-field-compare.mjs fonts`) reported:

| Field | Koko (before) | Chrome |
|-------|-----------------|--------|
| `emojiSet` | `["😀"]` only (44 emojis missing) | 44 emoji entries with logical sizes |
| `fontFaceLoadFonts` | Unquoted multi-word families | Quoted strings e.g. `"Helvetica Neue"` |
| `pixelSizeSystemSum` | `0` | `~0.181` |
| `platformVersion` | `"macOS Ventura"` | `undefined` |

Section hash mismatched while `lies=0`—pure value / serialization drift.

---

## Root Cause

### 1. Logical vs physical sizing

The fonts probe measures **logical** used sizes from computed style, not border-box client rects. Koko returned `"auto"` for `inline-size` / `block-size` because those longhands were unimplemented in `CSSStyleDeclaration.getComputedPropertyValue`. Only a subset of emojis (😀) had special-case code paths.

CreepJS `getPixelEmojis()` in `code-check/sites/creep/creep.js` depends on non-auto logical sizes for each emoji in the test grid.

### 2. Transform exclusion vs client rects

`.pixel-emoji` elements use `transform: scale(1.000999)`. **Logical sizes exclude transform**; **client rects include it**. Reusing `client_rects_emoji_dims` baseline dimensions verbatim overshoots `pixelSizeSystemSum`.

The fonts section requires baseline dims **divided by scale** and rounded to Chrome's float string format.

### 3. FontFace.family quoting

Chrome's `FontFace.load()` reports multi-word families with **literal quote characters** in the returned family string (e.g. `"Helvetica Neue"`). CreepJS `getPlatformVersion()` checks `fonts.includes('Helvetica Neue')` **without** quotes; quoted names **intentionally fail** that match on real Chrome, yielding `platformVersion: undefined`.

Koko's unquoted families both broke sort order in `fontFaceLoadFonts` and incorrectly inferred a macOS version string.

### 4. JSON.stringify hashing

CreepJS section hashes use `JSON.stringify` on collected objects. Sub-ulp differences in px strings (`"12.345678px"` vs `"12.345679px"`) change `pixelSizeSystemSum` hash even when emoji sets match visually.

---

## Investigation

### Probe commands

```bash
cd /Users/huydev/Desktop/koko
zig build install
node scripts/cdp-section-field-compare.mjs fonts
node scripts/cdp-creepjs-section-compare.mjs \
  --profile chrome-local-huys-macbook-pro \
  --max-sec 20
```

Output: `code-check/tmp/section-field-compare-fonts.json`

### Baseline assets

| Asset | Role |
|-------|------|
| `browser/profiles/assets/chrome-local-huys-macbook-pro-client-rects-baseline.json` | Per-emoji width/height from Chrome |
| Profile `clientRects` / emoji dim maps | Feed `ClientRectsIntelligent` |

Confirmed: dividing Chrome client-rect dims by scale factor **`1.0009992842860176`** for `.pixel-emoji` only, rounding to **6 decimal places**, reproduces Chrome `pixelSizeSystemSum` exactly.

### CreepJS functions traced

- `getPixelEmojis()` — logical sizes, emoji set
- `getFontFaceLoadFonts()` — `FontFace.load` family strings
- `getPlatformVersion()` — heuristic on font list contents

---

## Solution

| Area | Fix | Location |
|------|-----|----------|
| `inline-size` / `block-size` | `ClientRectsIntelligent.lookupEmojiLogicalSize()` for `.pixel-emoji` and `.domrect-emoji` | `CSSStyleDeclaration.getComputedPropertyValue` |
| Scale correction | Divide logical dims by `1.0009992842860176` for `.pixel-emoji` only | `ClientRectsIntelligent` |
| Px format | Round to 6 decimal places before appending `px` | serialization path |
| `FontFace.family` | Return `"Family Name"` (with quotes) when family contains a space | FontFace / load shim |
| `platformVersion` | `undefined` as side effect of quoted families matching Chrome heuristic | — |

### Code locations

- `src/core/webapi/css/CSSStyleDeclaration.zig` — logical size longhands
- `src/runtime/profile/ClientRectsIntelligent.zig` — emoji dim lookup and scale
- Font face load path (navigator / document fonts module)

After fixes, `fonts` section reports **MATCH** in section compare; remaining session goals shifted to sub-ulp `domrectSystemSum` on **clientRects** (see display probe note).

### Why fonts matter for antidetect beyond CreepJS

Commercial fingerprint vendors and open-source collectors increasingly combine **font metrics** with canvas and WebGL signals. A user claiming macOS Sonoma with Windows-only font metrics—or emoji logical sizes of `"auto"`—is trivially scored. Koko's approach mirrors other high-fidelity sections: capture Chrome ground truth into profile assets, then serve values through the same DOM APIs CreepJS calls (`getComputedStyle`, `FontFace.load`), not parallel shortcut getters that CreepJS never uses.

### npm / CI entry points

```bash
npm run test:creepjs:compare   # wraps section compare
npm run test:creepjs:local     # local CreepJS hosting variant
```

Always `zig build install` before probes so `zig-out/bin/koko` reflects font/CSS changes.

### Debugging checklist for fonts regressions

1. Run field compare first — confirm whether `emojiSet`, `fontFaceLoadFonts`, or `pixelSizeSystemSum` regressed.
2. If `emojiSet` shrank, check `inline-size` / `block-size` on `.pixel-emoji` before revisiting client-rect baselines.
3. If `pixelSizeSystemSum` is non-zero but wrong, verify scale divisor `1.0009992842860176` and 6-decimal rounding—not client-rect values copied without transform correction.
4. If `platformVersion` reappears, inspect `FontFace.family` strings for missing quotes on multi-word macOS families.
5. Confirm built-in display is primary when sums drift—see [1680 display probe](../creepjs-probe-1680-display.md).

---

## Lessons Learned

- **CreepJS uses different geometry APIs per section:** `clientRects` → bounding rects; `fonts` → logical computed sizes. Implement both deliberately.
- **`FontFace.family` quoting is fingerprint-relevant**, not cosmetic string formatting.
- **Do not infer platform version** where Chrome leaves `undefined`—antidetect “helpfulness” becomes detectable signal.
- **Section hashes use `JSON.stringify`**; float fields need Chrome-identical serialization, not mathematically close values.
- **Reuse client-rect emoji baselines for fonts**, but apply transform correction—one Chrome capture, two consumption rules.

---

## References

- CreepJS: `code-check/sites/creep/creep.js` — `getPixelEmojis`, `getFontFaceLoadFonts`, `getPlatformVersion`
- Probe: `scripts/cdp-section-field-compare.mjs fonts`
- Section compare: `scripts/cdp-creepjs-section-compare.mjs`
- Baseline capture: `scripts/capture-client-rects-baseline.mjs`
- Profile: `browser/profiles/chrome-local-huys-macbook-pro.json`

---

## Related Knowledge

- [CreepJS cssMedia parity](../css-media/creepjs-cssmedia-parity.md) — separate media / custom-property surface
- [CreepJS probe 1680×1050 display](../creepjs-probe-1680-display.md) — geometry-sensitive sums
- [Owner frame cross-document styles](../../browser/iframe/owner-frame-cross-document-styles.md) — iframe style reads (less central to fonts, critical for cssMedia)