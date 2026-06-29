# CreepJS probe requires MacBook built-in (1680×1050)

## Summary

Profile `chrome-local-huys-macbook-pro` targets the MacBook built-in panel: **1680×1050**, `availHeight` **936**, `colorDepth` **30**, wide-gamut `p3`. Chrome CDP probes read the **OS primary display**. If an external monitor is primary (e.g. 1920×1080), section compare drops from **23/25** to **20/25** even though Velora code is unchanged.

---

## Problem

`scripts/cdp-creepjs-section-compare.mjs` reported inconsistent match counts (23 vs 20) on the same profile because Chrome reported different `screen` geometry between runs.

---

## Root Cause

- Velora uses static profile screen values.
- Chrome creep uses live `window.screen` from the primary display.
- CDP `Emulation.setDeviceMetricsOverride` and `defineProperty` screen spoofing either miss `availHeight`/`colorDepth` or trigger CreepJS `lies`.

---

## Solution

1. Keep profile at **1680×1050** (user choice).
2. Probe script loads profile screen and **exits 2** if `Chrome screen.width ≠ profile.screen.width`, with a message to set built-in as primary in **System Settings → Displays**.
3. Re-capture SVG/clientRects baselines while built-in is primary.

---

## Expected results (built-in primary)

- **23/25** section hashes with matching FP ID after svg/cssMedia fixes.
- Remaining drift: `clientRects.domrectSystemSum`, `fonts.pixelSizeSystemSum` (sub-ulp tuning in profile / scale).

---

## References

- `scripts/lib/profile-screen.mjs`
- `scripts/cdp-creepjs-section-compare.mjs`