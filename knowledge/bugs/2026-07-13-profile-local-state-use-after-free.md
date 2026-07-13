# Local State.json corruption from syncLocalState use-after-free

## Summary

`ProfileManager.syncLocalState` called `freeLocalState` while still reading `state.last_used`, and merged stale JSON profile names after freeing the profiles slice. This caused segfaults on `velora profile list` / `velora version` and wrote garbage entries like `[170,170,...]` into `Local State.json`.

## Root cause

1. `freeLocalState` freed `last_used` before the last-used validation loop ran.
2. `loadLocalState` returned struct defaults (`last_used = "Default"`) as static literals that `freeLocalState` attempted to free.
3. `help` / `version` modes ran full `initInPlace` and `deinit` on uninitialized `http_headers` / `profile_paths`.

## Fix

- Rebuild `syncLocalState` from on-disk discovered directories only; never merge freed JSON profile pointers.
- `sanitizeLocalState` + `isValidProfileName` filter corrupt JSON entries.
- Skip profile bootstrap / deinit for `.profile`, `.help`, `.version` modes.
- Use `fileExists()` helper instead of invalid `access()` optional syntax (Zig 0.15).

## Recovery

If `Local State.json` already contains garbage arrays, delete it and run `velora profile list` to regenerate from disk.