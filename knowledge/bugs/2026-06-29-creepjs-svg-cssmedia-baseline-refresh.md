# CreepJS svg + cssMedia Parity — Baseline Refresh and Wide-Gamut Correction

> **Phase 1** fingerprint sweep in [`google-search-investigation-journey.md`](../captcha/detection/google-search-investigation-journey.md). Follows [`SVGRect prototype fix`](./2026-06-29-creepjs-svg-bbox-svrect-prototype.md) and [`dashed-ident tokenizer`](./2026-06-29-css-dashed-ident-tokenizer.md).

## Summary

Koko reached **23/25** CreepJS section hash matches against live Chrome on the MacBook profile (`chrome-local-huys-macbook-pro`) when Chrome reported the same display geometry (1680×1050, P3 gamut). This session closed `svg` and `cssMedia` outright, refreshed Chrome-captured baselines for SVG geometry and client rects, and narrowed `clientRects` / `fonts` to sub-ulp `pixelSizeSystemSum` / `domrectSystemSum` drift. Root causes split three ways: wrong `color-gamut` media default (`srgb` vs `p3`), stale offline SVG baselines captured before full font warmup, and `getBBox` ignoring profile JSON. The lesson: CreepJS probes are **async, font-dependent integration tests** — isolated HTML fixtures lie.

---

## Problem

After the `SVGRect` prototype fix ([prior note](./2026-06-29-creepjs-svg-bbox-svrect-prototype.md)), four sections still diffed:

| Section | Symptom | Chrome | Koko |
|---------|---------|--------|--------|
| `svg` | `bBox`, `emojiSet` (® missing), `extentOfChar`, `svgrectSystemSum` | match targets | drift |
| `cssMedia` | `color-gamut` | `p3` | `srgb` |
| `clientRects` | 12 rect objects + `domrectSystemSum` | golden | stale JSON |
| `fonts` | `pixelSizeSystemSum` | golden | scale drift |

`lies` gate stayed at 0 across sections — failures were **semantic**, not prototype lie detection.

### Architectural context

CreepJS fingerprint sections are not independent unit tests. They form a **pipeline**:

1. **Font warmup** — `@font-face` and system font metrics load asynchronously; `queueEvent` gates measurement.
2. **SVG text probes** — emoji glyphs measured via `getComputedTextLength` / `getBBox` with full `CSS_FONT_FAMILY` stack.
3. **CSS media injection** — `@media` blocks set `--prefers-*` custom properties on `body`; `getComputedStyle` reads them.
4. **Checksum aggregation** — sums of absolute values over prototype keys, emoji ctl strings, DOMRect lists.

Koko's profile system (`browser/profiles/assets/*.json`) supplies golden outputs per machine. If capture tooling runs **before** fonts settle or with a **short font stack**, baselines encode wrong geometry while the engine might be correct — or vice versa.

---

## Root Cause

### 1. `color-gamut` — viewport media semantics

`MediaQueryList` and `StyleManager` viewport defaulted to `srgb`. The reference MacBook Chrome session on built-in display reports **wide-gamut `p3`** via `(color-gamut: p3)`.

This is independent of the dashed-ident tokenizer fix — `matchMedia('(color-gamut: p3)')` could pass while `mediaCSS` fields still failed if custom properties were broken (see [cssMedia parity doc](../fingerprint/css-media/creepjs-cssmedia-parity.md)).

### 2. SVG baseline stale

`capture-svg-baseline.mjs` originally used:

- Short font stack (not full CreepJS `CSS_FONT_FAMILY`)
- Synchronous measurement (no `queueEvent` / font warmup wait)

CreepJS loads the full font list, awaits async font events, then measures. Stale `perEmojiComputedTextLength` made **®** collide with another emoji pattern in `emojiSet` hashing; `bBox` / `extentOfChar` sums diverged from live creep.

### 3. `getBBox` ignored profile

`SvgIntelligent.lookupBBox` and `creepSvgBBox()` returned hardcoded fallbacks instead of `profile.svg_baseline.b_box` for the `#svgBox` probe element.

### 4. Client rects baseline stale

`elementClientRects` JSON held pre-capture values (`20.109375` vs Chrome live `20.1171875`). Sub-pixel DOMRect differences cascade into `domrectSystemSum`.

### 5. Fonts scale documentation drift

`pixel_emoji_logical_scale` was `1.001058…` in engine; knowledge doc cited `1.000999…` — documentation lag, not primary bug.

---

## Investigation

### Probe commands

```bash
cd /Users/huydev/Desktop/koko

# Full section compare (20s budget)
node scripts/cdp-creepjs-section-compare.mjs \
  --profile chrome-local-huys-macbook-pro --max-sec 20

# Per-field drill-down
node scripts/cdp-section-field-compare.mjs svg
node scripts/cdp-section-field-compare.mjs cssMedia
node scripts/cdp-section-field-compare.mjs clientRects
node scripts/cdp-section-field-compare.mjs fonts
```

### Baseline recapture workflow

1. Rewrote `scripts/capture-svg-baseline.mjs` to navigate live CreepJS, wait for `Fingerprint.svg`, rebuild SVG probe with **full font list** after fonts warm.
2. Re-ran `scripts/capture-client-rects-baseline.mjs` for fresh `elementClientRects`.
3. Ran `scripts/capture-emoji-rects-baseline.mjs` for `emojiDims` (fonts + domrect pattern input).

### Verified captured baseline matched live creep

| Metric | Value |
|--------|-------|
| `bBox` abs-sum | ≈ **660.17** (matches `Fingerprint.svg.bBox`) |
| `extentOfChar` sum | ≈ **305.95** |
| `emojiSet` entries | **43** including **®** |
| `svgrectSystemSum` | **0.06961428535461427** |

### Display geometry trap

Chrome probe geometry flips between **1680×1050** (built-in) and **1920×1080** (external primary). Profile screen dimensions must match the display Chrome actually uses during compare — documented in [cssMedia parity](../fingerprint/css-media/creepjs-cssmedia-parity.md).

---

## Solution

| Area | Change | File(s) |
|------|--------|---------|
| `cssMedia` gamut | `color_gamut = .p3` | `MediaQueryList.zig`, `StyleManager.zig` |
| SVG profile reads | `creepSvgBBox(frame)` → `profile.svg_baseline`; `lookupBBox` for `#svgBox` | `SvgIntelligent.zig` |
| SVG baseline asset | Re-captured from live creepjs | `chrome-local-huys-macbook-pro-svg-baseline.json` |
| Client rects asset | Re-captured | `chrome-local-huys-macbook-pro-client-rects.json` |
| ClientRects golden | Updated `creep_rects` | `ClientRectsIntelligent` |
| Capture tooling | CreepJS-navigating svg baseline | `capture-svg-baseline.mjs` |

Combined with prior fixes:

- [`SVGRect` prototype](./2026-06-29-creepjs-svg-bbox-svrect-prototype.md) — correct key enumeration for `bBox`
- [`dashed-ident` tokenizer](./2026-06-29-css-dashed-ident-tokenizer.md) — `--prefers-*` custom properties
- [Owner frame routing](../browser/iframe/owner-frame-cross-document-styles.md) — iframe phantom `body` styles

### Verification

```bash
node scripts/cdp-creepjs-section-compare.mjs \
  --profile chrome-local-huys-macbook-pro --max-sec 20

node scripts/cdp-section-field-compare.mjs svg
node scripts/cdp-section-field-compare.mjs cssMedia
```

**Pass:** `svg` and `cssMedia` → **0 field diffs**, section hash MATCH.

**Remaining:** `clientRects` / `fonts` sub-ulp tuning — emoji dimension strings extremely sensitive.

---

## Lessons Learned

1. **CreepJS SVG/fonts/clientRects probes require post-async font warmup and the full creep font list** — isolated HTML probes drift.
2. **`Fingerprint.svg.bBox` is `sum(abs(keys))` over `SVGRect` prototype keys only (4 keys)** — see SVGRect note; do not sum edge getters.
3. **Profile baselines are integration test artifacts** — regenerate from live CreepJS after engine fixes, not from simplified fixtures.
4. **`matchMediaCSS` and `mediaCSS` test different subsystems** — evaluator vs stylesheet custom property injection ([cssMedia parity](../fingerprint/css-media/creepjs-cssmedia-parity.md)).
5. **Display geometry must match reference Chrome session** — not assumed monitor size.
6. **`domrectSystemSum` / `pixelSizeSystemSum` are sub-ulp battlefields** — expect iterative baseline tuning after major font/SVG changes.
7. **CreepJS green ≠ Google Search tier** — journey doc Phase 1 verdict; this work is necessary antidetect hygiene, not Search unlock.

---

## References

- [`google-search-investigation-journey.md`](../captcha/detection/google-search-investigation-journey.md) — Phase 1 fingerprint sweep
- [`2026-06-29-creepjs-svg-bbox-svrect-prototype.md`](./2026-06-29-creepjs-svg-bbox-svrect-prototype.md)
- [`2026-06-29-css-dashed-ident-tokenizer.md`](./2026-06-29-css-dashed-ident-tokenizer.md)
- [`creepjs-cssmedia-parity.md`](../fingerprint/css-media/creepjs-cssmedia-parity.md)
- [`creepjs-css-parity.md`](../fingerprint/css/creepjs-css-parity.md)
- [`creepjs-fonts-parity.md`](../fingerprint/fonts/creepjs-fonts-parity.md)
- Scripts: `scripts/cdp-creepjs-section-compare.mjs`, `scripts/capture-svg-baseline.mjs`

---

## Related Knowledge

- [CreepJS SVGRect bBox prototype](./2026-06-29-creepjs-svg-bbox-svrect-prototype.md) — prerequisite geometry fix
- [CSS dashed-ident tokenizer](./2026-06-29-css-dashed-ident-tokenizer.md) — custom property parsing
- [Owner frame cross-document styles](../browser/iframe/owner-frame-cross-document-styles.md) — iframe cssMedia routing
- [CreepJS cssMedia parity](../fingerprint/css-media/creepjs-cssmedia-parity.md) — full cssMedia section story
- [CreepJS fonts parity](../fingerprint/fonts/creepjs-fonts-parity.md) — `pixelSizeSystemSum` inputs
- [Google Search investigation journey](../captcha/detection/google-search-investigation-journey.md) — fingerprint vs session tier weighting