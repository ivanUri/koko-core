# Window `Object.getOwnPropertyNames` Hook for CreepJS `windowFeatures`

## Summary

CreepJS `windowFeatures` hashes `Object.keys(Object.getOwnPropertyNames(window))` order against a Chrome baseline. Velora exposed extra globals and a different key order. `WindowKeysIntelligent` installs a profile-driven `Object.getOwnPropertyNames` hook that reorders keys to match captured Chrome order and filters noise, restoring section **MATCH** with `lies=0`.

---

## Problem

`windowFeatures` section hash mismatched Chrome despite correct individual APIs. Field compare showed `windowFeatures` / key list order entirely different from Chrome's ~900+ property enumeration on macOS Chrome 149.

---

## Root Cause

CreepJS does not hash raw `window` objects — it hashes the **ordered list** from `Object.getOwnPropertyNames(window)` (after filtering numeric/noise keys).

Velora's antidetect runtime added:

- Extra properties not present on Chrome
- Different insertion order for inherited/builtin keys
- Phantom iframe probing context (`filtered.length >= 900`) — hook must apply when CreepJS enumerates the iframe `window`, not only the main `window`

A failed earlier attempt redefined `Object` properties in a loop that **deleted `Object` first**, causing `Object is not defined` and a CreepJS hang. The fix requires preserving `Object` before any delete/redefine sequence (`const Obj = Object`).

---

## Investigation

- Section compare: `windowFeatures` diff with `lies=0` → ordering/enumeration issue.
- CreepJS uses phantom window with 900+ keys — hook threshold `filtered.length >= 900` targets that path.
- Confirmed hang when hook script deleted global `Object` before saving reference.

---

## Solution

`WindowKeysIntelligent.installOnDocument` (in `Frame._documentIsLoaded`, antidetect mode only):

1. **Prune** runtime-only globals not in Chrome baseline (regex noise `/_|\d{3,}/` excluded from reorder set).
2. **Hook `Object.getOwnPropertyNames`**: when filtered result has ≥900 keys, return Chrome order from `window-keys.json` profile asset, append any remaining keys not in baseline.
3. **Save `Object` reference** before mutating built-ins in any install script.

Profile: `browser/profiles/assets/chrome-local-huys-macbook-pro-window-keys.json`.

---

## Lessons Learned

- Property **order** is fingerprint surface area, not just presence/absence.
- Hooks that touch global intrinsics must never delete the intrinsic before caching a reference.
- Test enumeration in **phantom iframe** context — CreepJS does not always probe `window` directly.
- Install intelligence at `_documentIsLoaded`, not context creation, to keep `lies` gate at 0.

---

## References

- CreepJS `windowFeatures` / `getPrototypeLies` paths in `code-check/sites/creep/creep.js`
- ECMAScript — `Object.getOwnPropertyNames`
- Velora: `src/runtime/profile/WindowKeysIntelligent.zig`, `src/core/browser/Frame.zig`
- Chrome baseline: `browser/profiles/assets/chrome-local-huys-macbook-pro-window-keys.json`

---

## Related Knowledge

- [CreepJS cssMedia parity](../css-media/creepjs-cssmedia-parity.md) (same probe harness)