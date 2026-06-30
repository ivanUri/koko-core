# CreepJS Probe Requires MacBook Built-In Display (1680×1050)

## Summary

Velora's reference antidetect profile `chrome-local-huys-macbook-pro` targets a **MacBook built-in Retina panel**: **1680×1050** logical resolution, `screen.availHeight` **936**, `colorDepth` **30**, wide-gamut **Display P3**. CreepJS and Velora CDP probes compare **live Chrome** `window.screen` against **static profile** screen values. Chrome reads the **OS primary display**; Velora serves profile JSON. When an external monitor is primary (e.g. **1920×1080**), section compare drops from **23/25** to **20/25** with **no code changes**—a harness geometry mismatch, not a regression.

Antidetect work must treat **display topology** as part of the test fixture, alongside profile JSON and Zig binaries.

---

## Problem

`scripts/cdp-creepjs-section-compare.mjs` reported inconsistent match counts on the same commit:

| Run condition | Typical match count | Affected sections |
|---------------|---------------------|-------------------|
| Built-in display primary | **23/25** | `screen`, `cssMedia`, `clientRects`, others tied to geometry |
| External monitor primary | **20/25** | Same profile, different Chrome ground truth |

Symptoms included:

- `screen` section hash mismatch (`width`/`height`/`availHeight`/`colorDepth`)
- `cssMedia.screenQuery` returning `{1920, 1080}` in Chrome while profile assumed `{1680, 1050}`
- `matchMediaCSS.color-gamut` flipping between `p3` and `srgb` depending on which display Chrome associated with the probe window
- False “fixes” attempted in Zig when the real issue was **where the engineer sat**

`scripts/cdp-section-field-compare.mjs` field diffs for `screen` and `cssMedia` were the fastest way to see geometry drift before chasing section hashes.

---

## Root Cause

### Two sources of truth

| Source | What it provides | When it applies |
|--------|------------------|-----------------|
| **Profile JSON** | Static `screen.width`, `screen.height`, `availHeight`, `colorDepth`, media features | Velora runtime, `matchMedia`, layout viewport |
| **Live Chrome CDP** | Whatever `window.screen` reports from macOS **primary display** | Ground truth for compare scripts |

Velora intentionally uses static profile values so fingerprints are **deterministic** across machines. Chrome on the probe laptop is **not** deterministic unless display settings are fixed.

### Why CDP emulation is insufficient

Attempts to align Chrome via CDP `Emulation.setDeviceMetricsOverride` or `defineProperty` on `screen` either:

- Miss sub-fields CreepJS reads (`availHeight`, `colorDepth`, `pixelDepth`)
- Trigger CreepJS **lie detection** (`lies > 0`), failing the antidetect gate even when values look right

The approved approach is **environmental**: make the OS primary display match the profile, not spoof Chrome at probe time.

### Sections coupled to geometry

CreepJS hashes that incorporate screen dimensions or media queries include:

- **`screen`** — direct `window.screen` enumeration
- **`cssMedia`** — `device-width` binary search via injected `@media` custom properties; `device-aspect-ratio` from iframe `win.screen`
- **`clientRects`** / **`fonts`** — emoji probe layout; sub-ulp `domrectSystemSum` / `pixelSizeSystemSum` drift when scale factors change
- **`svg`** — baseline captured at a specific viewport and font warm-up state

See `knowledge/bugs/2026-06-29-creepjs-svg-cssmedia-baseline-refresh.md` for the session that reached 23/25 on the correct display.

---

## Investigation

### Section compare (full harness)

```bash
cd /Users/huydev/Desktop/velora
zig build install
node scripts/cdp-creepjs-section-compare.mjs \
  --profile chrome-local-huys-macbook-pro \
  --max-sec 20
```

Output: `code-check/tmp/creepjs-section-compare/` — per-section hash MATCH/MISMATCH, FP ID, `lies` count.

### Field compare (pinpoint geometry)

```bash
node scripts/cdp-section-field-compare.mjs screen
node scripts/cdp-section-field-compare.mjs cssMedia
```

Output: `code-check/tmp/section-field-compare-<section>.json`

### Profile screen loader

`scripts/lib/profile-screen.mjs` reads `browser/profiles/chrome-local-huys-macbook-pro.json` screen block and compares against Chrome's reported `screen.width` at probe start. On mismatch, the section compare script **exits code 2** with a message to set the built-in panel as primary in **System Settings → Displays**.

### npm shortcuts

From repo root:

```bash
npm run test:creepjs:compare   # section compare wrapper
npm run test:creepjs:local     # local CreepJS server variant
```

### Reproducing the failure

1. Connect external monitor, set it as **primary** in macOS Display settings.
2. Run section compare with `chrome-local-huys-macbook-pro` unchanged.
3. Observe Chrome reporting **1920×1080** while profile holds **1680×1050**.
4. Match count drops (~20/25); `cssMedia.screenQuery` and `screen` diffs appear in field compare JSON.

---

## Solution

1. **Keep profile at 1680×1050** (user hardware choice for the reference MacBook).
2. **Before any CreepJS baseline capture or section compare**, ensure built-in display is **primary**:
   - **System Settings → Displays → Arrange** — drag menu bar to built-in.
   - Confirm Chrome `screen.width === 1680` (field compare or probe script guard).
3. **Re-capture geometry-sensitive baselines** when display policy changes:
   - `browser/profiles/assets/chrome-local-huys-macbook-pro-svg-baseline.json` — `scripts/capture-svg-baseline.mjs`
   - Client rects emoji dims — `scripts/capture-client-rects-baseline.mjs`
4. **Do not mix baselines** captured on 1920×1080 Chrome with a 1680×1050 profile (noted in `creepjs-cssmedia-parity.md` for `screenQuery`).

### Expected results (built-in primary)

- **23/25** section hashes with matching FP ID after svg/cssMedia fixes
- Remaining drift (if any): `clientRects.domrectSystemSum`, `fonts.pixelSizeSystemSum` — sub-ulp tuning in profile scale factors, not display topology

### Velora code locations (unchanged by display fix)

| Area | Path |
|------|------|
| Profile screen load | `src/runtime/profile/ProfileStore.zig` |
| Screen IDL | `src/core/webapi/window/Screen.zig` (and related) |
| Media query viewport | `src/core/webapi/css/MediaQueryList.zig`, `StyleManager` |

The fix is **procedural**; Zig screen emulation already serves profile values correctly when the profile matches the intended hardware story.

---

## Lessons Learned

- **CreepJS compare is a system test**, not a unit test—it binds OS display, Chrome version, profile JSON, and `zig-out/bin/velora`.
- **Always run `profile-screen.mjs` guard** (or read exit code 2) before trusting section counts in CI notes or PR descriptions.
- **Field compare before section hash** isolates `screen.width` vs entire `cssMedia` object.
- **Baselines are valid only for the Chrome session geometry** used during capture; document display settings in commit messages when refreshing assets.
- **Antidetect profiles encode a physical machine narrative** (MacBook P3, 30-bit color). Probing on a docked 1080p monitor without updating the profile is a false negative factory.

---

## References

- `scripts/cdp-creepjs-section-compare.mjs` — full 25-section hash compare
- `scripts/cdp-section-field-compare.mjs` — per-section field diff
- `scripts/lib/profile-screen.mjs` — width guard vs profile
- `browser/profiles/chrome-local-huys-macbook-pro.json` — screen block
- `knowledge/bugs/2026-06-29-creepjs-svg-cssmedia-baseline-refresh.md` — 23/25 milestone

---

## Related Knowledge

- [CreepJS cssMedia parity](./css-media/creepjs-cssmedia-parity.md) — `screenQuery` and `color-gamut` depend on probe display
- [CreepJS fonts parity](./fonts/creepjs-fonts-parity.md) — `pixelSizeSystemSum` geometry sensitivity
- [TLS / JA3 / JA4 parity](./tls/creepjs-tls-ja3-ja4-parity.md) — orthogonal transport-layer checks