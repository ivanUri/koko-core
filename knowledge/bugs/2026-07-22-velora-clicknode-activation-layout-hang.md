# Velora.clickNode Fast Activation Hang (Layout Hit-Test)

> **Date:** 2026-07-22 · **Area:** InputController, CDP LP, Fluent/React signup · **Status:** Core hang fixed; Hotmail password step still open

## Summary

`Velora.clickNode` on Fluent **Next** (`signup.live.com`) returned immediately but then **blocked the CDP thread for tens of seconds**, so every subsequent `Runtime.evaluate` timed out. Sampling showed the stall was **not** form-submit navigation: it was `dispatchActivationOnElementFast` → `makeHitForElement` → `getActivationBoundingClientRect` → recursive `computeLayoutOriginForHitTestDepth` + sibling visibility walks on a deep Fluent tree.

After skipping layout geometry in the fast path, trusted click + form `submit` complete in **0 ms**, React `preventDefault`s, and `CheckAvailableSigninNames` returns **200** with `isAvailable: true`. Password-step SPA transition is a separate remaining issue.

---

## Problem

Hotmail register probe symptoms:

1. Email field fill OK (local-part; Fluent strips `@domain` from display).
2. `Velora.clickNode` / CDP mouse on Next → **CDP timeout: Runtime.evaluate** forever after.
3. Pointer geometry was also wrong: Next `getBoundingClientRect` collapsed (~40×19 at x≈0); hit tests landed on **footer** / help divs.

Native `sample` during hang:

```
Runner.waitCDP → runMacrotasks → scheduleActivationOnElement
  → dispatchActivationOnElementFast
    → makeHitForElement → centerHitOnElement
      → getActivationBoundingClientRect
        → computeLayoutOriginForHitTestDepth (deep recursion)
          → flowOffsetAmongSiblingsForHitTest
            → checkVisibilityCached / StyleManager.isHidden (HashMap)
```

Main thread sat in this path for the entire sample window — CDP transport could not service evaluates.

---

## Root Cause

`dispatchActivationOnElementFast` was documented as a **layout-light** trusted click for automation, but it still called `makeHitForElement`, which recomputes activation geometry via a **full flow-origin walk** over Fluent’s large DOM.

That walk is O(depth × siblings × style lookups). On signup SPA trees it becomes pathologically expensive and runs **synchronously on the CDP connection thread** (scheduled activation after `Velora.clickNode` reply), starving `Runtime.evaluate`.

Secondary issues:

| Issue                                                | Effect                                           |
| ------------------------------------------------------| --------------------------------------------------|
| Form controls default to `layout_default_size` (5px) | Pointer centers miss buttons                     |
| Hotmail script double-fired pointer + Velora.clickNode   | Wrong hit + hang                                 |
| New-email re-fill after prefill                      | Broke React state; blocked second CheckAvailable |

---

## Fix

### Core (`InputController.dispatchActivationOnElementFast`)

Do **not** call `makeHitForElement` / `getActivationBoundingClientRect`. Build a hit with `(client_x, client_y) = (0, 0)` and dispatch a **trusted** `click` only. Default action still runs (`handleClick` → `submitForm` → SubmitEvent). Coordinates are irrelevant for Fluent/React submit handlers.

### Core (`Element` layout helpers)

1. UA-ish defaults for `input` / `button` / `select` / `textarea` when CSS width/height are unresolved (reduces 5×5 collapse).
2. Cap sibling walk in `flowOffsetAmongSiblingsForHitTest` (max 48) and use cheap `isHiddenForLayout` instead of full visibility HashMap for each prior sibling.

### Script (`hotmail-register-velora.mjs`)

- Prefer **Velora.clickNode only**; pointer only if rect looks real (≥24×16).
- On New-email step, **keep prefilled local-part** — do not re-fill full email or retype when already correct.
- Drop `requestSubmit` / Enter after Next (historical hang sources).

---

## Verification

```bash
cd /Users/huydev/Desktop/velora
zig build
# Velora-only: trusted click on BUTTON, submit preventDefault, CheckAvailable 200
node scripts/_hotmail-s2-nofill.mjs   # or hotmail-register-velora.mjs --probe-email-step
```

| Check | Result |
|-------|--------|
| Velora.clickNode returns without CDP hang | **OK** (0 ms path) |
| `click` isTrusted on BUTTON | **OK** |
| `submit` preventDefault after React | **OK** |
| First CheckAvailable → New email UI | **OK** |
| Second CheckAvailable `isAvailable:true` (no re-fill) | **OK** |
| Password field after isAvailable | **Still failing** (SPA does not advance) |

---

## Remaining (password step)

Second `CheckAvailableSigninNames` response:

```json
{ "isAvailable": true, "nopaAllowed": false, "type": "Live", "apiCanary": "...", "telemetryContext": "..." }
```

Fluent JS dispatches `SetMemberName` / `UpdateCheckAvailableStateMap` when `isAvailable`, but the password view never mounts (no JS exception observed). Likely next areas: React concurrent scheduler / MessageChannel after fetch, risk/Human iframe gate, or missing ServerData/canary application. Track separately from this layout hang.

---

## Files

- `src/core/browser/InputController.zig` — layout-free `dispatchActivationOnElementFast`
- `src/core/dom/Element.zig` — form-control defaults; sibling walk cap
- `scripts/hotmail-register-velora.mjs` — LP-first click; no New-email re-fill

---

## Lessons

1. “Fast activation” must not call full layout hit-test — especially on SPA trees with hundreds of siblings.
2. CDP methods that schedule work on the transport thread must stay O(1) after reply; layout belongs offline or budgeted.
3. Automation should prefer **node-targeted** activation over broken approximate geometry.
4. Fluent multi-step forms: **do not re-type** prefilled React-controlled values; full email on domain-suffix UI fails custom validation even when HTML5 validity is true.
