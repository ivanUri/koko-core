# CreepJS svg bBox inflated by DOMRect prototype keys

## Symptom

Online CreepJS `svg.bBox` stored **1192.66** on Velora vs Chrome **661.17**, while a fresh CDP re-run of the same DOM logic returned correct bbox components.

## Root cause

CreepJS `getSVG()` aggregates bbox via:

```javascript
const keys = Object.keys(svgBox.getBBox().__proto__);
const bBox = keys.reduce((acc, key) => ({ ...acc, [key]: native[key] }), {});
const bBoxSum = Object.keys(bBox).reduce((acc, k) => acc + Math.abs(bBox[k]), 0);
```

Chrome `SVGRect.prototype` exposes only **x, y, width, height**.

Velora returned `DOMRect` with **top, right, bottom, left** also enumerable on the immediate prototype, so CreepJS double-counted edge getters and summed **8** fields instead of **4**.

## Fix

- Added `src/core/dom/SVGRect.zig` with prototype chain `SVGRect → DOMRectReadOnly`.
- `SVGRect` JsApi exposes only `x/y/width/height`.
- `getBBox()` / `getExtentOfChar()` on SVG elements return `*SVGRect`.
- SVG geometry uses `_skip_quantize` on `DOMRectReadOnly` so CreepJS sums match Chrome f64 getters.

## Verification

After fix, field compare:

- `bBox`: C=661.1685009 V=661.1685009 (match)
- `extentOfChar`: within ~1e-13 of Chrome

## Remaining svg drift

- `svgrectSystemSum`: baseline `perEmojiComputedTextLength` unique-sum is **0.0719886** vs Chrome creep **0.0716133** (emojiSet membership already matches).
- Needs refreshed per-emoji ctl capture under full CreepJS emoji list (93 entries incl. duplicate 😀).