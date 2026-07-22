# WindowKeys prune deleted page-assigned globals at DOMContentLoaded

> **Date:** 2026-07-22 · **Area:** antidetect WindowKeysIntelligent · **Status:** Core fix landed

## Summary

Antidetect `WindowKeysIntelligent` prune ran at **DOMContentLoaded** and `delete`d every `globalThis` own property not on the Chrome profile allow-list. Site UMD shells installed earlier in the parse (e.g. `window.webShellClient` on Nike) were removed mid-hydration. React then threw while reading `.identity`, recovered with client render (#418/#423), or fell into an application-error shell. Prune now **keeps any property whose value is not `undefined`**, so page-assigned objects/functions survive while empty fingerprint stubs can still be stripped.

## Problem

Timeline on `https://www.nike.com/vn/`:

1. Parser scripts set `window.webShellClient = { identity, locale, … }`.
2. DOMContentLoaded → WindowKeys prune → **`webShellClient` gone** (`hasOwn === false`).
3. Header React code: `window.webShellClient.identity` → TypeError.
4. React #418 / #423 hydration recovery; images unmounted or delayed.
5. Previously: full “Application error: a client-side exception has occurred”.

Same class of bug already hit `window.next` / `TURBOPACK` (allow-listed by name). Allow-listing every site global does not scale.

## Root Cause

`buildPruneScript` (install runs from `Frame._documentIsLoaded` after parser scripts):

```js
for (const k of Object.getOwnPropertyNames(globalThis)) {
  if (allowed || runtimeAssigned) continue;
  prune.push(k); // deleted everything else, including real UMD exports
}
```

## Solution

```js
if (globalThis[k] !== undefined) continue; // keep page-assigned values
// only prune leftover undefined stubs not on the allow-list
```

Still removes pure `undefined` noise not in the profile key list. Does not hardcode site names.

## Related

- Replaced-element 300×150 default object size (`Element.zig`) so image loaders measure non-collapsed boxes.
- `HTMLImageElement.naturalWidth/Height` after load (`Image.zig`).

## Verify

After fix: `typeof webShellClient === "object"` past DCL; Nike hero/card images gain real `src` (static.nike.com). React may still log #418/#423 once (client recovery) without wiping the tree.
