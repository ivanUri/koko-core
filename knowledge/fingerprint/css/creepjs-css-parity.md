# CreepJS `css` section parity

## Summary

CreepJS fingerprints `getComputedStyle(document.body)` by collecting prototype keys, enumerable instance keys, and alias counterparts expanded via the `in` operator. Velora now matches Chrome's 1392-key merged list by splitting profile data into indexed dash-case keys, enumerable camelCase keys, and a full `in`-allowlist for shorthand aliases.

---

## Problem

The `css` section failed on `computedStyle.keys` with three symptom classes:

1. Wrong `interfaceName` (`Object` vs `CSSStyleDeclaration`) — fixed earlier via prototype `Symbol.toStringTag`.
2. Wrong system colors — fixed earlier in `resolveSystemColor`.
3. Key count/order mismatch: Velora emitted 1396 keys (four extra `background-repeat-x/y` aliases) and diverged in order after index 15 (`anchor-name` missing from indexed enumeration).

---

## Root Cause

Chrome's `CSSStyleDeclaration` exposes computed properties through two enumerable channels that CreepJS merges:

| Channel | Chrome behavior | Velora bug |
|---------|-----------------|------------|
| Indexed `0..length-1` | 472 dash-case properties via `item()` | Used stale `computed_style_properties.zig` (old creep list, no `anchor-name`) |
| `Object.keys()` strings | 732 camelCase accessors | Returned full merged baseline (1392 keys) or wrong list |
| `key in style` alias expansion | +188 shorthand / webkit dash-case aliases | `getNamed` rejected empty values via `isKnownCSSProperty` |

CreepJS builds the final key list as:

```
Set([
  ...getOwnPropertyNames(proto),
  ...ownEnumerableFromObjectKeys,
  ...aliasCounterpartsFoundViaInOperator,
])
```

Velora failed because indexed enumeration used the wrong source list, and `getNamed` did not admit shorthand properties that Chrome exposes only through `in`, not through `Object.keys`.

---

## Investigation

1. Field compare: `node scripts/cdp-section-field-compare.mjs css`
2. Diff analysis showed four Velora-only keys (`background-repeat-x/y`) and order divergence at `anchor-name`.
3. Chrome CDP probe (`code-check/tmp/probe-css-objkeys.mjs`) captured ground truth:
   - `length = 472`
   - `Object.keys` numeric values: 472 dash-case names in Chrome order
   - `Object.keys` strings: 732 camelCase names
   - `background-repeat-x in style` → `false` on Chrome
4. Full CreepJS output (1392 keys) = 1204 enumerable + 188 alias-expansion keys present in Chrome's merged baseline JSON.

---

## Solution

1. **Profile assets**
   - `browser/profiles/assets/chrome-local-huys-macbook-pro-css-enumerable-keys.json` — `{ indexed: [472], named: [732] }` captured from Chrome.
   - `browser/profiles/assets/chrome-local-huys-macbook-pro-css-computed-keys.json` — full 1392 merged list for `in` parity.

2. **ProfileStore** — load `enumerableKeysFile` into `css_computed_indexed_keys` / `css_computed_named_keys`, and `dataFile` into `css_computed_in_keys`.

3. **CSSStyleDeclaration** (computed style paths)
   - `length` / `item` / `[int]` enumeration → indexed keys
   - `getNamedKeys` → named camelCase keys only
   - `getNamed` → allow any key in `css_computed_in_keys`; return `""` for unset values instead of `NotHandled`
   - Removed `background-repeat-x/y` from `computed_style_properties.zig` fallback map

4. **Window.getComputedStyle** returns `CSSStyleDeclaration` (not `CSSStyleProperties`) so CreepJS reads the correct prototype chain.

---

## Lessons Learned

- Do not feed CreepJS's final merged key array into `getNamedKeys`; Chrome enumerates a smaller set and relies on `in` for alias expansion.
- Always capture Chrome ground truth with a CDP probe (indexed vs named vs `in`) before tuning profile JSON.
- `zig build` may not rebuild `zig-out/bin/velora` when only cached; delete the binary or touch sources before probing.

---

## References

- CreepJS source: `code-check/sites/creep/creep.js` (`getCSS` → `computeStyle`)
- Probe: `node scripts/cdp-section-field-compare.mjs css`
- Profile: `browser/profiles/chrome-local-huys-macbook-pro.json` → `cssComputedKeys`

---

## Related Knowledge

- [CreepJS fonts parity](../fonts/creepjs-fonts-parity.md)
- [CreepJS cssMedia parity](../css-media/creepjs-cssmedia-parity.md)