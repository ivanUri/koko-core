# CreepJS `navigator` Section Parity (Verified)

## Summary

Velora matches Chrome on the full CreepJS **`navigator`** fingerprint section for profile `chrome-local-huys-macbook-pro`: **0 field-level diffs** in `cdp-section-field-compare.mjs` and identical section hash within the 20-second probe budget. The work spanned **prototype key order**, **WebGPU adapter metadata and limits**, **`userAgentData.uaFullVersion`**, and earlier fixes for permissions / `bluetoothAvailability`.

The `navigator` section is among the densest CreepJS surfaces—hardware concurrency, UA-CH, GPU limits, MIME types, and prototype reflection in one hash. Antidetect browsers that patch `userAgent` alone still fail here.

---

## Problem

Initial compare showed **34 field diffs**:

| Area | Symptom |
|------|---------|
| `properties` | `Object.keys(Object.getPrototypeOf(navigator))` order entirely differed |
| `userAgentData.uaFullVersion` | Profile stale (`149.0.7827.158`) vs live Chrome (`.197`) |
| `webgpu.adapterInfo` | Velora `google` / `angle`; Apple Silicon Chrome `apple` / `metal-3` |
| `webgpu.limits` | ~30 limit keys missing or wrong magnitudes |

Permissions and `bluetoothAvailability` had been fixed in an earlier pass; section hash still failed on enumeration and GPU surfaces with `lies=0`.

---

## Root Cause

### 1. Prototype enumeration (not `getOwnPropertyNames`)

CreepJS `getNavigator()` hashes **`properties`**: ordered keys from `Object.keys(Object.getPrototypeOf(navigator))`. This is a **different API pattern** than `windowFeatures`, which uses `Object.getOwnPropertyNames(window)` (see [window-features-opn-hook.md](./window-features-opn-hook.md)).

Velora exposed a different set and **insertion order** on `Navigator.prototype` because:

- IDL bindings installed properties in implementation order
- Some Chrome-only keys were missing entirely
- No reorder hook existed at document load

### 2. WebGPU synchronous fingerprint path

CreepJS reads:

- `adapter.info` synchronously when present, else `requestAdapterInfo()`
- `adapter.limits` via `for…in` enumeration—**every enumerable limit key** enters `hashMini(limits)`

Partial limit objects or wrong vendor strings (`google`/`angle` vs `apple`/`metal-3` on macOS) change the section hash even when WebGPU rendering works.

### 3. Profile version drift

`uaFullVersion` in JSON profile lagged Chrome patch rev. CreepJS includes full version in navigator blob; mismatch fails hash without affecting `userAgent` string parity.

---

## Investigation

### Field compare

```bash
cd /Users/huydev/Desktop/velora
zig build install
node scripts/cdp-section-field-compare.mjs navigator
```

Output: `code-check/tmp/section-field-compare-navigator.json` — authoritative Chrome snapshot for the session.

### Section compare

```bash
node scripts/cdp-creepjs-section-compare.mjs \
  --profile chrome-local-huys-macbook-pro \
  --max-sec 20
```

### Captured baselines

From field compare JSON:

- `properties` array — **82 keys** in Chrome order
- Full `webgpu.limits` object — all keys and numeric string values

### CreepJS source

`code-check/sites/creep/creep.js` — `getNavigator()`, `getWebGpu()`.

### Install timing

Hooks must run at **`Frame._documentIsLoaded`** in antidetect mode so CreepJS phantom iframe sees patched prototypes before first read—same timing as `WindowKeysIntelligent` (see `knowledge/captcha/detection/google-search-investigation-journey.md` Phase 1).

---

## Solution

| Change | Location |
|--------|----------|
| `NavigatorKeysIntelligent` — install missing keys on `Navigator.prototype`, hook `Object.keys` to Chrome order | `src/runtime/profile/NavigatorKeysIntelligent.zig` |
| Profile asset `chrome-local-huys-macbook-pro-navigator-keys.json` (82 keys) | `browser/profiles/assets/` |
| `navigatorKeys` in profile JSON + `ProfileStore` loader | `browser/profiles/chrome-local-huys-macbook-pro.json`, `ProfileStore.zig` |
| Install at `_documentIsLoaded` | `src/core/browser/Frame.zig` |
| `GPUAdapter.info` sync object (`apple`, `metal-3`) | `navigator_extras.zig` |
| Full Chrome limit map on `GPUAdapter.limits` | `navigator_extras.zig` |
| `uaFullVersion` → `149.0.7827.197` | profile JSON |

### NavigatorKeysIntelligent behavior (summary)

1. Load 82-key Chrome order from profile asset.
2. Define any missing prototype properties CreepJS expects.
3. Hook `Object.keys` for `Navigator.prototype` targets to return Chrome order (distinct from window `getOwnPropertyNames` hook).

### Verification

- `cdp-section-field-compare.mjs navigator` → **0 diffs**
- `cdp-creepjs-section-compare.mjs` → `navigator` **MATCH**, `lies=0`

### Antidetect scoring context

Real-world collectors rarely isolate a single `navigator` field. They combine:

- **UA-CH** (`userAgentData.brands`, `platform`, `mobile`, `uaFullVersion`)
- **Hardware** (`hardwareConcurrency`, `deviceMemory`, `maxTouchPoints`)
- **GPU** (WebGPU limits exceed legacy `webgl` renderer string entropy on Apple Silicon)
- **Prototype shape** (`properties` order catches incomplete Chromium forks)

Velora's split strategy—**profile JSON for values**, **KeysIntelligent for enumeration order**, **navigator_extras for WebGPU**—keeps each concern updatable when Chrome ships a new limit key without rewriting the entire binding layer.

### Refresh procedure when Chrome updates

1. Bump `uaFullVersion` and brands in `chrome-local-huys-macbook-pro.json`.
2. Re-run `node scripts/cdp-section-field-compare.mjs navigator`.
3. If `properties` or `webgpu.limits` diffs appear, re-export `chrome-local-huys-macbook-pro-navigator-keys.json` from field compare JSON.
4. Confirm `NavigatorKeysIntelligent` install still runs at `_documentIsLoaded` in antidetect profiles only.

### Cross-links in the 25-section harness

`navigator` is probed early in CreepJS startup. Downstream sections (`workerScope`, `webgl`, `svg`) assume `navigator` values are stable on first read. A regression here often correlates with FP ID drift across multiple sections even when those sections were not modified—always check `navigator` field compare when unexplained hash changes appear elsewhere.

Pair navigator work with [TLS parity](../tls/creepjs-tls-ja3-ja4-parity.md): `userAgentData` brands must align with the Chrome major version impersonated on the wire.

Use `npm run test:creepjs:compare` for full 25-section regression after navigator profile bumps.

---

## Lessons Learned

- **`windowFeatures` uses `getOwnPropertyNames`; `navigator.properties` uses `Object.keys` on prototype** — different hooks, do not reuse one for the other.
- **WebGPU fingerprint includes every enumerable limit key**, not just common texture/bind limits—copy Chrome's full map from field compare JSON.
- **Capture enumeration baselines from the same Chrome session** used for compare; mixing versions invalidates order.
- **`uaFullVersion` is independent of `userAgent`** in UA-CH era—keep profile JSON on the same patch level as TLS/impersonate target.
- **Navigator is high-value for antidetect** because it is stable, synchronous, and run early—ideal for bot scoring.

---

## References

- CreepJS: `code-check/sites/creep/creep.js` — `getNavigator()`, `getWebGpu()`
- Probe: `scripts/cdp-section-field-compare.mjs navigator`
- Section compare: `scripts/cdp-creepjs-section-compare.mjs`
- Velora: `src/runtime/profile/NavigatorKeysIntelligent.zig`, `navigator_extras.zig`, `Frame.zig`
- Profile asset: `browser/profiles/assets/chrome-local-huys-macbook-pro-navigator-keys.json`

---

## Related Knowledge

- [Window `Object.getOwnPropertyNames` hook](./window-features-opn-hook.md) — sibling enumeration pattern for `windowFeatures`
- [CreepJS cssMedia parity](../css-media/creepjs-cssmedia-parity.md) — same probe harness
- [Speech synthesis voices timing](../audio/speech-synthesis-voices-timing.md) — another synchronous-first-read API
- [TLS / JA3 / JA4 parity](../tls/creepjs-tls-ja3-ja4-parity.md) — transport layer must match UA major version