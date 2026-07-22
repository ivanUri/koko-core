# history.pushState: Location Stale vs document.URL

> **Date:** 2026-07-22 · **Area:** History, Location, SPA routers · **Status:** Core fix landed; password view needed animationend (see css-animationend-fluent-route)

## Summary

On `signup.live.com`, `history.pushState(state, "", "/SignUpPasswordCollection")` updated **`document.URL` / `document.baseURI`** and history length, but **`window.location.pathname` / `href` stayed `/`**. That desync breaks Fluent’s SPA navigation (`k(UsernameCollection, SignUpPasswordCollection)` → React route match → password view).

Location getters now always read **`frame.url`** (browsing-context source of truth). History push/replace mutate Location in place and keep `document._url` aligned.

Isolated check after fix:

| Access | Before | After |
|--------|--------|-------|
| `document.URL` | new path | new path |
| `window.location.pathname` | **`/` (stale)** | **`/SignUpPasswordCollection`** |
| `document.location.pathname` | new path | new path |
| object identity `location === document.location` | false | true |

---

## Problem

Hotmail register after email availability:

1. Second `CheckAvailableSigninNames` returns **200** + `isAvailable: true`.
2. Fluent JS is supposed to navigate to `SignUpPasswordCollection`.
3. UI stayed on **New email**; no password input.

Diagnosis:

```js
history.pushState({x:1}, '', '/SignUpPasswordCollection');
// document.URL === '.../SignUpPasswordCollection'  ✓
// location.pathname === '/'                        ✗
// window.location !== document.location (identity)
```

On a plain static page the same pushState worked for both. The signup document + history stack made the bug visible (Location identity / cached `_url` vs `frame.url`).

---

## Root Cause

1. **History.replaceState** reallocated `window._location = Location.init(...)`, breaking JS identity expectations and leaving some bindings on a stale Location.
2. **Location getters** (`pathname`, `href`/`toString`, …) read **`Location._url`**, which could lag or diverge from **`frame.url`** (what `document.URL` uses via `document._url orelse frame.url`).
3. SPA routers (Fluent + React Router-style path matching) trust **`window.location`**. Stale pathname ⇒ no password route mount.

---

## Fix

### `Location.zig`

Getters take `frame` and resolve from **`frame.url`** (`liveRaw`), not a possibly-stale `_url` pointer.

### `History.zig`

Shared `applyHistoryUrl`:

- Set `frame.url`
- Update `window._location._url` **in place** (no new Location object)
- Set `document._url` so document.URL stays consistent

---

## Verification

```bash
cd /Users/huydev/Desktop/velora
zig build
# scripts/_hotmail-loc-diag.mjs — pushState then read location.pathname
```

| Check | Result |
|-------|--------|
| pushState updates `window.location.pathname` on signup.live.com | **OK** |
| `location === document.location` | **OK** |
| CheckAvailable `isAvailable:true` | **OK** (unchanged) |
| Password field after New-email Next | **Still open** (path often remains `/` — Fluent may not call navigate, or another gate blocks ActivateView) |

---

## Remaining

After `isAvailable: true`, Fluent’s `zU` should pick `SignUpPasswordCollection` when `usernameType === Live`, then `k(source, dest)` should navigate. With Location fixed, direct `pushState` to that path works, but the live form still does not change `pathname` after the API success — so either navigate is not invoked, or another state gate (risk/Human, usernameType, scheduler) blocks view activation. Next: instrument `k` / `usernameType` on the New-email submit path.

---

## Files

- `src/core/webapi/Location.zig`
- `src/core/webapi/History.zig`
- `src/core/webapi/Window.zig` (secure-context / origin call sites)
- `src/core/webapi/selector/List.zig` (`:target` hash via frame)

---

## Lessons

1. **`frame.url` is source of truth** for the browsing context; Location must not permanently diverge.
2. Prefer **in-place Location mutation** over reallocating the Location object after history updates.
3. When debugging SPA “API 200 but no view change”, compare **`document.URL` vs `location.pathname`** first.
