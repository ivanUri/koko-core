# CreepJS `navigator` Section Parity (Verified)

## Summary

Velora matches Chrome on the full CreepJS `navigator` fingerprint section after fixing prototype key order, WebGPU adapter metadata/limits, and `uaFullVersion`. Field compare reports **0 diffs**; section hash matches in the 20s probe budget.

---

## Problem

`navigator` diverged on 34 fields:

- `properties`: `Object.keys(Object.getPrototypeOf(navigator))` order differed entirely
- `userAgentData.uaFullVersion`: profile stale vs live Chrome
- `webgpu.adapterInfo`: Velora reported `google`/`angle`; Chrome on Apple Silicon reports `apple`/`metal-3`
- `webgpu.limits`: ~30 limit keys missing or wrong magnitudes

Permissions and `bluetoothAvailability` were fixed earlier; hash still failed on enumeration and GPU surfaces.

---

## Root Cause

1. **Prototype enumeration** — CreepJS hashes key **order** on `Navigator.prototype`, not `getOwnPropertyNames(window)`. Velora exposed a different set/order of prototype properties.

2. **WebGPU** — CreepJS reads `adapter.info` synchronously when present, else `requestAdapterInfo()`. Limits are enumerated with `for…in` on `adapter.limits`. Partial limit objects change `hashMini(limits)`.

3. **Profile drift** — `uaFullVersion` in JSON profile lagged Chrome patch rev (`149.0.7827.197` vs `.158`).

---

## Investigation

```bash
node scripts/cdp-section-field-compare.mjs navigator
```

Captured Chrome `properties` array (82 keys) and full `webgpu.limits` object from `code-check/tmp/section-field-compare-navigator.json`.

---

## Solution

| Change | Location |
|--------|----------|
| `NavigatorKeysIntelligent` — install missing keys on `Navigator.prototype`, hook `Object.keys` to Chrome order | `src/runtime/profile/NavigatorKeysIntelligent.zig` |
| Profile asset `chrome-local-huys-macbook-pro-navigator-keys.json` (82 keys) | `browser/profiles/assets/` |
| `navigatorKeys` in profile JSON + `ProfileStore` loader | profile + `ProfileStore.zig` |
| Install hook at `_documentIsLoaded` | `Frame.zig` |
| `GPUAdapter.info` sync object (`apple`, `metal-3`) | `navigator_extras.zig` |
| Full Chrome limit map on `GPUAdapter.limits` | `navigator_extras.zig` |
| `uaFullVersion` → `149.0.7827.197` | profile JSON |

---

## Lessons Learned

- `windowFeatures` uses `getOwnPropertyNames`; `navigator.properties` uses `Object.keys` on **prototype** — different hooks required.
- WebGPU fingerprint includes **every enumerable limit key**, not just common texture/bind limits.
- Capture enumeration baselines from the same Chrome session used for compare (field compare JSON is authoritative).

---

## References

- CreepJS `getNavigator()` / `getWebGpu()` in `code-check/sites/creep/creep.js`
- [Window keys parity note](./window-features-opn-hook.md) (different API pattern)
- Velora: `NavigatorKeysIntelligent.zig`, `navigator_extras.zig`

---

## Related Knowledge

- [Window `Object.getOwnPropertyNames` hook](./window-features-opn-hook.md)
- [CreepJS cssMedia parity](../css-media/creepjs-cssmedia-parity.md)