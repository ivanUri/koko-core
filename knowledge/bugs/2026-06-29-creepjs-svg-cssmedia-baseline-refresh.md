# CreepJS svg + cssMedia parity (baseline refresh)

## Summary

Velora reached **23/25** CreepJS section hash matches against live Chrome on the MacBook profile when Chrome reports the same display geometry (1680×1050, P3 gamut). This session fixed `svg` and `cssMedia` outright, refreshed Chrome-captured baselines for SVG geometry and client rects, and narrowed `clientRects` / `fonts` to sub-ulp `pixelSizeSystemSum` / `domrectSystemSum` drift.

---

## Problem

After the `SVGRect` prototype fix, four sections still diffed:

| Section | Symptom |
|---------|---------|
| `svg` | `bBox`, `emojiSet` (® missing), `extentOfChar`, `svgrectSystemSum` |
| `cssMedia` | `color-gamut`: Chrome `p3` vs Velora `srgb` |
| `clientRects` | 12 rect objects + `domrectSystemSum` |
| `fonts` | `pixelSizeSystemSum` |

---

## Root Cause

1. **`color-gamut`** — `MediaQueryList` and `StyleManager` viewport defaulted to `srgb`; this Mac Chrome session reports wide-gamut `p3`.

2. **SVG baseline stale** — `capture-svg-baseline.mjs` used a short font stack and synchronous measurement. CreepJS loads the full `CSS_FONT_FAMILY`, awaits `queueEvent`, then measures. Stale `perEmojiComputedTextLength` made ® collide with another emoji pattern; `bBox` / `extentOfChar` sums diverged from live creep.

3. **`getBBox` ignored profile** — `SvgIntelligent.lookupBBox` and `creepSvgBBox()` returned hardcoded fallbacks instead of `profile.svg_baseline.b_box`.

4. **Client rects baseline stale** — `elementClientRects` JSON still held pre-capture values (`20.109375` vs Chrome live `20.1171875`).

5. **Fonts scale** — `pixel_emoji_logical_scale` was `1.001058…`; knowledge doc documented `1.000999…` for logical-size correction.

---

## Investigation

- `node scripts/cdp-creepjs-section-compare.mjs --profile chrome-local-huys-macbook-pro`
- `node scripts/cdp-section-field-compare.mjs <section>`
- Rewrote `scripts/capture-svg-baseline.mjs` to navigate creepjs, wait for `Fingerprint.svg`, rebuild SVG probe with full font list after fonts are warm.
- Re-ran `scripts/capture-client-rects-baseline.mjs` for fresh `elementClientRects`.
- `scripts/capture-emoji-rects-baseline.mjs` for `emojiDims` (fonts + domrect pattern input).

Verified captured baseline:

- `bBox` abs-sum ≈ **660.17** (matches creep `Fingerprint.svg.bBox`)
- `extentOfChar` sum ≈ **305.95**
- `emojiSet` **43** entries including **®**
- `svgrectSystemSum` **0.06961428535461427**

---

## Solution

| Area | Change |
|------|--------|
| `cssMedia` | `color_gamut = .p3` in `MediaQueryList.zig`, `StyleManager.zig` |
| SVG profile | `creepSvgBBox(frame)` reads `profile.svg_baseline`; `lookupBBox` uses profile for `#svgBox` |
| SVG baseline | `browser/profiles/assets/chrome-local-huys-macbook-pro-svg-baseline.json` re-captured from creepjs |
| Client rects | `chrome-local-huys-macbook-pro-client-rects.json` + `ClientRectsIntelligent` golden `creep_rects` updated |
| Capture tooling | `capture-svg-baseline.mjs` creepjs-based; `capture-client-rects-baseline.mjs` simplified |

---

## Lessons Learned

- CreepJS SVG/fonts/clientRects probes depend on **post-async font warmup** and the **full** creep font list — isolated HTML probes drift.
- `Fingerprint.svg.bBox` is `sum(abs(keys))` over `SVGRect` prototype keys only (4 keys) — see prior `SVGRect` note.
- Chrome probe geometry can flip between **1680×1050** (built-in) and **1920×1080** (external primary display); profile must match the display Chrome actually uses during compare.
- `domrectSystemSum` / `pixelSizeSystemSum` are extremely sensitive to emoji dimension strings; sub-ulp baseline tuning may still be needed.

---

## References

- `knowledge/bugs/2026-06-29-creepjs-svg-bbox-svrect-prototype.md`
- `knowledge/fingerprint/css-media/creepjs-cssmedia-parity.md`
- Probe: `scripts/cdp-creepjs-section-compare.mjs`