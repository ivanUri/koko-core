# Window `Object.getOwnPropertyNames` Hook for CreepJS `windowFeatures`

## Summary

CreepJS **`windowFeatures`** hashes the **ordered key list** from `Object.keys(Object.getOwnPropertyNames(window))` (after internal filtering), not merely the presence of globals. Velora's antidetect runtime exposed **extra properties**, **different key order**, and a distinct enumeration in the **phantom iframe** context. `WindowKeysIntelligent` installs a profile-driven **`Object.getOwnPropertyNames` hook** that reorders keys to match captured Chrome order and prunes noise, restoring section **MATCH** with **`lies=0`**.

Property **order** is fingerprint surface area—a lesson that applies across `navigator.properties`, `css` computed keys, and `features.jsFeaturesKeys`. Antidetect patches that add APIs without fixing enumeration order still fail CreepJS and similar collectors.

---

## Problem

`windowFeatures` section hash mismatched Chrome on `chrome-local-huys-macbook-pro` despite individually correct APIs (`lies=0`). Field compare showed the entire `windowFeatures` key list order differed from Chrome's **~900+** property enumeration on macOS Chrome 149.

Secondary symptom during hook development: CreepJS **hung** when install script deleted global `Object` before caching a reference—`Object is not defined` in the probe iframe.

---

## Root Cause

### CreepJS algorithm

In `code-check/sites/creep/creep.js`, `windowFeatures` collection walks:

1. `Object.getOwnPropertyNames(window)` (with CreepJS filtering)
2. Ordered processing for hash input

Velora diverged because:

| Factor | Effect |
|--------|--------|
| Extra runtime globals | Keys Chrome does not expose on `window` |
| IDL / binding install order | Different insertion order for inherited/builtin keys |
| Phantom iframe context | CreepJS enumerates iframe `window` with `filtered.length >= 900`; hook must apply there, not only top-level `window` |
| Failed hook attempt | Redefining `Object` in a loop that **deleted `Object` first** broke all subsequent intrinsics |

### Distinction from navigator hook

| Section | Enumeration API | Velora hook |
|---------|-----------------|-------------|
| `windowFeatures` | `Object.getOwnPropertyNames(window)` | `WindowKeysIntelligent` |
| `navigator.properties` | `Object.keys(Object.getPrototypeOf(navigator))` | `NavigatorKeysIntelligent` |

Reusing one hook for both fails field compare.

---

## Investigation

### Section compare

```bash
cd /Users/huydev/Desktop/velora
zig build install
node scripts/cdp-creepjs-section-compare.mjs \
  --profile chrome-local-huys-macbook-pro \
  --max-sec 20
```

`windowFeatures` showed **MISMATCH** with `lies=0` → ordering/enumeration issue, not lie detection.

### Field compare

```bash
node scripts/cdp-section-field-compare.mjs features
```

The `features` extractor includes `windowFeatures` array for diff (`scripts/cdp-section-field-compare.mjs`).

### Phantom iframe threshold

CreepJS uses a phantom / behemoth iframe where `getOwnPropertyNames(window)` returns **900+** keys after filtering. Hook logic gates on `filtered.length >= 900` to target that path without altering small test windows.

### Hang postmortem

Early hook script pattern:

```javascript
// BAD: deletes Object before saving reference
delete globalThis.Object;
// ... redefine loop → hang
```

Fix: `const Obj = Object` **before** any delete/redefine sequence.

---

## Solution

### WindowKeysIntelligent

`src/runtime/profile/WindowKeysIntelligent.zig` — `installOnDocument` called from `Frame._documentIsLoaded` (antidetect mode only).

Steps:

1. **Prune** runtime-only globals not in Chrome baseline (regex noise `/_|\d{3,}/` excluded from reorder set).
2. **Hook `Object.getOwnPropertyNames`**: when filtered result has **≥900** keys, return Chrome order from profile asset `chrome-local-huys-macbook-pro-window-keys.json`, append any remaining keys not in baseline (forward compatibility).
3. **Preserve `Object` reference** before mutating built-ins in any injected install script.

### Profile wiring

| Asset | Path |
|-------|------|
| Window key order baseline | `browser/profiles/assets/chrome-local-huys-macbook-pro-window-keys.json` |
| Profile reference | `browser/profiles/chrome-local-huys-macbook-pro.json` → `windowKeys` |
| Loader | `src/runtime/profile/ProfileStore.zig` |

### Install timing

Install at **`_documentIsLoaded`**, not bare context creation—matches navigator keys and keeps CreepJS `lies` gate at 0 when prototype layouts are probed after document init.

Related pruning work for Google Search: `knowledge/captcha/detection/google-search-investigation-journey.md` (Phase 1 window-keys).

### What the hook does not fix

`WindowKeysIntelligent` addresses **enumeration order and noise keys** on `window`. It does not replace:

- Per-API semantic parity (`chrome.runtime`, WebRTC, permissions)
- `features.jsFeaturesKeys` or `cssFeatures` (separate CreepJS sections)
- `navigator.properties` (requires `NavigatorKeysIntelligent`)

Section compare should be run holistically—passing `windowFeatures` with a broken `navigator` still yields a detectable FP ID.

### Capturing a new window-keys baseline

When Chrome adds or reorders global properties (common in major releases):

```bash
node scripts/cdp-section-field-compare.mjs features
# Extract windowFeatures array from code-check/tmp/section-field-compare-features.json
# Update browser/profiles/assets/chrome-local-huys-macbook-pro-window-keys.json
```

Re-run section compare with phantom iframe path (`filtered.length >= 900`) before merging.

### Interaction with creepjs_compat_shim

`src/core/js/creepjs_compat_shim.js` moves IDL members between `Element` and `HTMLElement` prototypes for Chrome layout parity. Window key hooks are orthogonal but share the same **document load** install window—order is: shim at context init, `WindowKeysIntelligent` / `NavigatorKeysIntelligent` at `_documentIsLoaded`. See `knowledge/bugs/2026-06-29-grecaptcha-htmlelement-style-shim.md` for shim failure modes.

### Security note for maintainers

Hooks that replace `Object.getOwnPropertyNames` affect **all** enumeration in the page, not only CreepJS. The `>= 900` key threshold limits scope to fingerprint-scale window objects. Lowering the threshold risks breaking third-party scripts that depend on native order for small objects—keep the gate unless field compare proves a narrower target is safe.

Document any baseline refresh in the PR: Chrome 150+ may add new globals that must be appended after the captured order block in `window-keys.json`.

---

## Lessons Learned

- **Property order is fingerprint surface area**, not just presence/absence—especially for `getOwnPropertyNames` which exposes implementation insertion order.
- **Hooks touching global intrinsics must never delete the intrinsic before caching a reference.**
- **Test enumeration in phantom iframe context** — CreepJS does not always probe top-level `window` directly.
- **Install intelligence at document load** aligns with other profile hooks (`NavigatorKeysIntelligent`, creepjs compat shim).
- **`lies=0` with hash mismatch** often means enumeration/reflection bugs—use field compare before debugging rendering or network.

---

## References

- CreepJS: `code-check/sites/creep/creep.js` — `windowFeatures`, `getPrototypeLies`
- ECMAScript: `Object.getOwnPropertyNames`
- Velora: `src/runtime/profile/WindowKeysIntelligent.zig`, `src/core/browser/Frame.zig`
- Chrome baseline: `browser/profiles/assets/chrome-local-huys-macbook-pro-window-keys.json`
- Probe: `scripts/cdp-section-field-compare.mjs features`
- Section compare: `scripts/cdp-creepjs-section-compare.mjs`

---

## Related Knowledge

- [CreepJS navigator parity](./creepjs-navigator-parity.md) — `Object.keys` on prototype (different hook)
- [CreepJS cssMedia parity](../css-media/creepjs-cssmedia-parity.md) — same probe harness, phantom iframe
- [CreepJS css parity](../css/creepjs-css-parity.md) — another ordered key-list fingerprint
- [Google Search investigation journey](../../captcha/detection/google-search-investigation-journey.md) — production pruning overlap