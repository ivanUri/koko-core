# CreepJS svg bBox Inflated by DOMRect Prototype Keys on SVGRect

> Fingerprint parity fix from **Phase 1** in [`google-search-investigation-journey.md`](../captcha/detection/google-search-investigation-journey.md). Prerequisite for [`svg + cssMedia baseline refresh`](./2026-06-29-creepjs-svg-cssmedia-baseline-refresh.md).

## Summary

Online CreepJS reported Velora `svg.bBox` checksum **1192.66** versus Chrome **661.17** — nearly double — while a fresh CDP re-run of the same DOM measurement logic on Velora returned correct bbox components. Root cause: CreepJS aggregates `getBBox()` results by enumerating `Object.keys(svgBox.getBBox().__proto__)`, and Chrome's `SVGRect.prototype` exposes only **four** fields (`x`, `y`, `width`, `height`). Velora returned a `DOMRect`-shaped object whose immediate prototype also enumerated **edge getters** (`top`, `right`, `bottom`, `left`), so CreepJS summed **eight** numeric fields instead of four. Fix: dedicated `SVGRect` type with prototype chain `SVGRect → DOMRectReadOnly`, exposing only the SVG geometry quad, plus `_skip_quantize` on read paths so f64 sums match Chrome.

---

## Problem

The `svg` section hash failed on Velora despite plausible individual `getBBox()` values when inspected in isolation. Field compare showed:

| Field | Chrome | Velora (before) |
|-------|--------|-----------------|
| `bBox` (abs-sum) | 661.1685009 | **1192.66** |
| `extentOfChar` | ~305.95 | inflated similarly |
| `lies` | 0 | 0 |

CreepJS was not flagging prototype lies — the failure was **semantic miscounting** due to prototype shape, not getter tampering detection.

### Why this matters architecturally

SVG geometry APIs (`SVGGraphicsElement.getBBox()`, `getExtentOfChar()`) return `DOMRectReadOnly`-like objects in the spec, but Web IDL distinguishes **`SVGRect`** as a separate interface for SVG-specific rectangles. Chromium's `SVGRect.prototype` is intentionally minimal: it carries the four component fields used in SVG user space without duplicating CSS box edge aliases on the same prototype tier that CreepJS enumerates.

Velora initially reused `DOMRect` for all rectangle-like returns. That was spec-adjacent but **fingerprint-wrong** because CreepJS's aggregation algorithm keys off **enumerable own keys of the immediate prototype object**, not `Object.getOwnPropertyNames` across the full interface set.

---

## Root Cause

CreepJS `getSVG()` bbox aggregation (simplified from `creep.js`):

```javascript
const keys = Object.keys(svgBox.getBBox().__proto__);
const bBox = keys.reduce((acc, key) => ({ ...acc, [key]: native[key] }), {});
const bBoxSum = Object.keys(bBox).reduce((acc, k) => acc + Math.abs(bBox[k]), 0);
```

### Chrome behavior

`SVGRect.prototype` exposes only:

- `x`, `y`, `width`, `height`

`bBoxSum ≈ 661.17` on the reference MacBook Chrome profile.

### Velora behavior (before fix)

`getBBox()` returned `DOMRect` with prototype enumerating **also**:

- `top`, `right`, `bottom`, `left`

Each edge getter computed from `x`/`y`/`width`/`height` — **correlated duplicates**. Summing absolute values of all eight fields ~doubled the checksum.

### Secondary interaction: quantization

Even with correct keys, sub-pixel quantization on `DOMRectReadOnly` getters could drift `extentOfChar` sums. SVG geometry paths needed `_skip_quantize` so CreepJS f64 aggregation matches Chrome bit patterns.

---

## Investigation

### Step 1 — Section field compare

```bash
cd /Users/huydev/Desktop/velora
node scripts/cdp-section-field-compare.mjs svg
node scripts/cdp-creepjs-section-compare.mjs --profile chrome-local-huys-macbook-pro --sections svg
```

Confirmed `bBox` as primary outlier; `emojiSet` and `svgrectSystemSum` were separate baseline issues (see baseline refresh note).

### Step 2 — Live prototype probe

CDP on Velora during CreepJS probe:

```javascript
const box = document.querySelector('#svgBox')?.getBBox?.() 
  || document.querySelector('svg')?.getBBox?.();
Object.keys(box.__proto__);
// Before fix: ["x","y","width","height","top","right","bottom","left"]
// Chrome:     ["x","y","width","height"]
```

### Step 3 — CreepJS source read

Located `getSVG()` aggregation in `code-check/sites/creep/creep.js` — uses `__proto__` key enumeration, not interface iterator.

### Step 4 — Lie detector cross-check

CreepJS `searchLies(() => SVGRect)` gate stayed 0 — confirms fix target is prototype **shape**, not spoofed getters.

### Step 5 — Quantization hypothesis (ruled in partially)

`extentOfChar` residual drift at ~1e-13 after prototype fix — addressed with `_skip_quantize` on SVG return paths.

### Step 6 — Cross-engine prototype audit

Compared `Object.getOwnPropertyNames(SVGRect.prototype)` in Chrome vs Velora via CDP. Chrome lists exactly four enumerable geometry fields on the `SVGRect` tier; Velora pre-fix listed eight on the object returned by `getBBox()`, matching `DOMRect` layout. This confirmed we needed a **separate `SVGRect` binding** in the Web IDL layer, not a tweak to CreepJS aggregation or lie-detector bypass.

---

## Solution

| Change | Location | Purpose |
|--------|----------|---------|
| `SVGRect.zig` type | `src/core/dom/SVGRect.zig` | Dedicated prototype with 4 fields only |
| Prototype chain | `SVGRect → DOMRectReadOnly` | Spec-aligned inheritance without edge keys on SVGRect tier |
| `getBBox()` / `getExtentOfChar()` | SVG element Web API | Return `*SVGRect` not `*DOMRect` |
| Profile-backed bbox | `SvgIntelligent.lookupBBox`, `creepSvgBBox()` | Use `profile.svg_baseline.b_box` for `#svgBox` |
| `_skip_quantize` | `DOMRectReadOnly` read path for SVG | Match Chrome f64 sums |

### Verification

```bash
node scripts/cdp-section-field-compare.mjs svg
node scripts/cdp-creepjs-section-compare.mjs --profile chrome-local-huys-macbook-pro --sections svg
```

After fix:

- `bBox`: C=661.1685009 V=661.1685009 (**match**)
- `extentOfChar`: within ~1e-13 of Chrome

### Remaining svg drift (documented separately)

- `svgrectSystemSum`: stale `perEmojiComputedTextLength` baseline — fixed in [baseline refresh note](./2026-06-29-creepjs-svg-cssmedia-baseline-refresh.md)
- Needs full CreepJS emoji list (93 entries) for ctl capture

---

## Lessons Learned

1. **Read the aggregator, not just the API return value.** CreepJS often hashes `Object.keys(obj.__proto__)` or similar — prototype enumerability is fingerprint surface area.
2. **`SVGRect` ≠ `DOMRect` for fingerprint purposes** even when numeric fields overlap.
3. **Correlated duplicate fields inflate sums silently** — edge getters are not independent measurements.
4. **lies=0 does not mean section match** — semantic aggregation can fail without lie detection firing.
5. **Profile baselines must be re-captured after geometry prototype fixes** — old JSON may encode pre-fix assumptions.
6. **Display geometry matters** — 1680×1050 vs 1920×1080 flips baselines; profile must match Chrome session during compare.

---

## References

- [SVGRect — MDN](https://developer.mozilla.org/en-US/docs/Web/API/SVGRect)
- [DOMRectReadOnly — MDN](https://developer.mozilla.org/en-US/docs/Web/API/DOMRectReadOnly)
- CreepJS `getSVG()` / `searchLies(() => SVGRect)` in `code-check/sites/creep/creep.js`
- Velora: `src/core/dom/SVGRect.zig`
- Velora: `src/runtime/profile/SvgIntelligent.zig`
- Probe: `scripts/cdp-creepjs-section-compare.mjs`, `scripts/cdp-section-field-compare.mjs`

---

## Related Knowledge

- [CreepJS svg + cssMedia baseline refresh](./2026-06-29-creepjs-svg-cssmedia-baseline-refresh.md) — follow-on baseline and gamut fixes
- [CreepJS CSS parity](../fingerprint/css/creepjs-css-parity.md) — related stylesheet geometry
- [CreepJS fonts parity](../fingerprint/fonts/creepjs-fonts-parity.md) — emoji ctl inputs for `svgrectSystemSum`
- [CreepJS navigator parity](../fingerprint/navigator/creepjs-navigator-parity.md) — Phase 1 fingerprint sweep context
- [Google Search investigation journey](../captcha/detection/google-search-investigation-journey.md) — fingerprint vs Search tier weighting