# CreepJS `css` Section Parity

## Summary

CreepJS builds a high-entropy **`css`** fingerprint from `getComputedStyle(document.body)` by merging three enumeration channels on `CSSStyleDeclaration`: prototype own-property names, `Object.keys()` strings (camelCase accessors), and shorthand **alias** keys discovered via the `in` operator. Velora now matches Chrome's **1392-key** merged list and correct `interfaceName` (`CSSStyleDeclaration`) on the `chrome-local-huys-macbook-pro` profile.

The fix split profile data into **indexed dash-case keys** (472), **enumerable camelCase keys** (732), and a full **`in`-allowlist** (1392), then rewired `CSSStyleDeclaration` computed-style paths so CreepJS's `computeStyle` algorithm sees Chrome-identical key count, order, and empty-string semantics for unset shorthand aliases.

For antidetect browsers, the `css` section is easy to underestimate: it is not “what color is `body`?” but **how the engine exposes the CSSOM computed property namespace**—a direct probe of JavaScript reflection fidelity.

---

## Problem

The `css` section failed `computedStyle.keys` with three symptom classes across investigation:

1. **`interfaceName`** — Velora reported `Object` instead of `CSSStyleDeclaration` (fixed earlier via prototype `Symbol.toStringTag`).
2. **System colors** — `-apple-system-*` and `Canvas` resolved wrong (fixed earlier in `resolveSystemColor`).
3. **Key count and order** — Velora emitted **1396** keys (four extra `background-repeat-x/y` aliases) and diverged in order after index 15 (`anchor-name` missing from indexed enumeration).

Section hash stayed red while `lies=0`, indicating **semantic enumeration drift**, not lie-detection trips.

---

## Root Cause

Chrome's `CSSStyleDeclaration` for computed style exposes properties through **two enumerable channels** that CreepJS merges with alias expansion:

| Channel | Chrome behavior | Velora bug (before fix) |
|---------|-----------------|-------------------------|
| Indexed `0..length-1` | **472** dash-case properties via `item()` | Stale `computed_style_properties.zig` list (old CreepJS export, no `anchor-name`) |
| `Object.keys()` strings | **732** camelCase accessors | Returned full 1392 merged baseline or wrong merged list |
| `key in style` alias expansion | **+188** shorthand / webkit dash-case aliases | `getNamed` rejected empty values via `isKnownCSSProperty` |

CreepJS constructs the final key list approximately as:

```
Set([
  ...getOwnPropertyNames(CSSStyleDeclaration.prototype),
  ...ownEnumerableFromObjectKeys,
  ...aliasCounterpartsFoundViaInOperator,
])
```

Velora failed because:

- **Indexed enumeration** used a stale hardcoded list instead of Chrome-order 472 dash-case names.
- **`getNamedKeys`** returned the CreepJS **final merged** array (1392) rather than Chrome's smaller `Object.keys` camelCase set (732).
- **`getNamed`** returned `NotHandled` for shorthand properties Chrome exposes through `in` with value `""` when unset—e.g. aliases not listed in `Object.keys`.
- **`background-repeat-x` / `background-repeat-y`** appeared in Velora's fallback map but `background-repeat-x in style` is **`false`** on Chrome—CreepJS only adds aliases that pass `in`.

Additionally, `Window.getComputedStyle` returned a `CSSStyleProperties` wrapper in some paths; CreepJS reads the prototype chain and expects **`CSSStyleDeclaration`**.

---

## Investigation

### Field compare (canonical)

```bash
cd /Users/huydev/Desktop/velora
zig build install
node scripts/cdp-section-field-compare.mjs css
```

Output: `code-check/tmp/section-field-compare-css.json` — field-level diff vs live Chrome CDP on CreepJS.

### Full section compare

```bash
node scripts/cdp-creepjs-section-compare.mjs \
  --profile chrome-local-huys-macbook-pro \
  --max-sec 20
```

### CDP ground-truth probe

A one-off probe (`code-check/tmp/probe-css-objkeys.mjs`) captured:

| Measurement | Chrome value |
|-------------|--------------|
| `length` | 472 |
| `Object.keys` numeric indices | 472 dash-case names in Chrome order |
| `Object.keys` strings | 732 camelCase names |
| `background-repeat-x in style` | `false` |
| CreepJS merged output | 1392 keys (= 1204 enumerable + 188 `in`-only aliases) |

Diff analysis showed four Velora-only keys and order divergence at `anchor-name`—the first indexed property present in Chrome 149 but missing from Velora's stale list.

### CreepJS source

In `code-check/sites/creep/creep.js`, `getCSS()` → `computeStyle()` performs the merge described above. Antidetect targets must match **algorithm inputs**, not only the printed 1392-array snapshot in an old JSON dump.

### Build cache pitfall

`zig build` may not rebuild `zig-out/bin/velora` when only cached artifacts change. Delete the binary or touch Zig sources before probing; otherwise field compare reports stale behavior.

---

## Solution

### 1. Profile assets (Chrome-captured)

| File | Purpose |
|------|---------|
| `browser/profiles/assets/chrome-local-huys-macbook-pro-css-enumerable-keys.json` | `{ indexed: [472], named: [732] }` |
| `browser/profiles/assets/chrome-local-huys-macbook-pro-css-computed-keys.json` | Full **1392** merged list for `in` parity |

Profile JSON references these via `cssComputedKeys` in `browser/profiles/chrome-local-huys-macbook-pro.json`.

### 2. ProfileStore loader

`src/runtime/profile/ProfileStore.zig` loads:

- `enumerableKeysFile` → `css_computed_indexed_keys` / `css_computed_named_keys`
- `dataFile` → `css_computed_in_keys`

### 3. CSSStyleDeclaration (computed paths)

`src/core/webapi/css/CSSStyleDeclaration.zig`:

- `length` / `item` / `[int]` → **indexed** 472 dash-case keys
- `getNamedKeys` → **732** camelCase keys only (not 1392)
- `getNamed` → allow any key in `css_computed_in_keys`; return `""` for unset values instead of `NotHandled`
- Removed `background-repeat-x/y` from `computed_style_properties.zig` fallback map

### 4. getComputedStyle return type

`Window.getComputedStyle` returns **`CSSStyleDeclaration`** (not `CSSStyleProperties`) so CreepJS reads the correct prototype / `Symbol.toStringTag`.

---

## Lessons Learned

- **Do not feed CreepJS's final 1392-key merged array into `getNamedKeys`.** Chrome enumerates a smaller camelCase set and relies on `in` for alias expansion—mirroring that split is required.
- **Capture Chrome ground truth with three probes** (indexed, named, `in`) before editing profile JSON; a single merged dump hides which channel broke.
- **`interfaceName` and key list are independent gates**—fixing `toStringTag` does not fix order/count.
- **Empty string is a valid computed value** for shorthand aliases in this fingerprint; `NotHandled` or `undefined` changes hash.
- **CSS parity is antidetect-critical** because it is cheap for sites to run and hard to fake without a real engine—or a painstakingly profile-driven reflection layer.

---

## References

- CreepJS: `code-check/sites/creep/creep.js` — `getCSS` → `computeStyle`
- Probe: `scripts/cdp-section-field-compare.mjs css`
- Section compare: `scripts/cdp-creepjs-section-compare.mjs`
- Velora: `src/core/webapi/css/CSSStyleDeclaration.zig`, `computed_style_properties.zig`, `ProfileStore.zig`
- Profile: `browser/profiles/chrome-local-huys-macbook-pro.json` → `cssComputedKeys`

---

## Related Knowledge

- [CreepJS fonts parity](../fonts/creepjs-fonts-parity.md) — also uses `getComputedStyle` but for `inline-size` / `block-size`
- [CreepJS cssMedia parity](../css-media/creepjs-cssmedia-parity.md) — custom properties via stylesheets, not computed key enumeration
- [Owner frame cross-document styles](../../browser/iframe/owner-frame-cross-document-styles.md) — iframe `getComputedStyle` routing (cssMedia; related CSS read paths)