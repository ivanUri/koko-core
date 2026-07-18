# SPA classic scripts: same-turn microtasks and checkpoint re-entry

> **Audience:** Velora engineers fixing Next/App Router client bootstrap and any SPA that ships large classic webpack chunks.  
> **Sites:** `demo.fingerprint.com/playground` (repro), any Next App Router CSR bailout shell.

## Summary

Fingerprint Pro’s playground (and other Next App Router CSR pages) loaded every `_next/static` chunk under Velora but stayed on the `BAILOUT_TO_CLIENT_SIDE_RENDERING` shell: `window.next` had only `{ version, appDir }`, no router, no Fingerprint agent network.

Root causes were **core lifecycle**, not site-specific JS shims:

1. Classic script evaluation during `ScriptManager.evaluate()` skipped same-turn microtask drains while `document.currentScript` was set.
2. Nested `runMicrotasks` re-entry drained only on a hard-coded `fingerprint.com` host allow-list; other (and even same-host mid-reentry) SPA `Promise.resolve().then` chains from webpack were deferred forever.
3. `OfflineAudioContext` completion resolved promises mid-flush without holding `checkpoint_active`, allowing nested `runMicrotasks` re-entry and intermittent segfaults after agent audio probes.

After generalizing those paths, Next’s `appBootstrap` → hydrate path installs `window.next.router` and React fiber on the playground shell. Full visitor-ID UI still needs the Fingerprint agent to finish without crashing — follow-up.

---

## Problem

| Symptom | Chrome | Velora (before) |
|---------|--------|-----------------|
| Document | 200, CSR bailout shell then results | 200 shell forever |
| Scripts | all chunks execute | all chunks execute |
| `webpackChunk_N_E.push` | webpack interceptor | sometimes installed |
| `window.next` | version + appDir + **router** | often only version + appDir |
| Agent | OfflineAudio + API | none / crash after audio |
| Console | clean | clean (silent stall) |

Tempting wrong fix: more `fingerprint.com` special cases, longer host-only watchdogs, or page-level JS polyfills.

---

## Root Cause

### Same-turn classic script microtasks

V8 is configured with **explicit** microtasks. Browsers still PerformCheckpoint after each classic script body while `document.currentScript` remains that element.

`Frame.drainClassicScriptMicrotasks` existed for Next/Turbopack `getAssetPrefix`, but returned immediately when `is_evaluating` was true — i.e. for **all** lifecycle classic scripts. Webpack’s main-app runtime does:

```js
e.O(0, [2971, 2117], () => { n(54278); n(77696); });
// 77696:
Promise.resolve().then(t.t.bind(t, 12846, 23));
// ...
```

Those reactions must run (or be tightly scheduled) so `appBootstrap(() => hydrate())` actually calls hydrate. Skipping the drain left `window.next = { version, appDir }` (set when the bootstrap module loads) without ever installing the router.

### Host-gated nested checkpoint

`Env.runMicrotasks` when already `checkpoint_active` only set `checkpoint_pending` — **except** a nested `PerformCheckpoint` loop for `fingerprint.com`. That meant:

- Nested `PromiseResolver.resolve` → `runMicrotasks` mid-checkpoint dropped work for general SPAs.
- Host allow-lists papered over one site while every other Next app stayed broken the same way.

### OfflineAudio flush re-entry

`flushOfflineAudioCompleteMicrotask` called `resolve()` per delivery without holding `checkpoint_active`. Each resolve could nest a full `runMicrotasks`, re-enter DOM/audio paths, and segfault (seen after `flush.resolved`).

---

## Solution (core only)

| Area | Change |
|------|--------|
| `Frame.drainClassicScriptMicrotasks` | Shallow same-turn drain (24 passes) while `is_evaluating`; full 48 when not |
| `Env.performMicrotaskCheckpointFp` | Participate in `checkpoint_active` + pending loop (no naked PerformCheckpoint) |
| `Env.runMicrotasks` re-entry | **All** live realms get shallow nested checkpoint (remove host allow-list) |
| `OfflineAudioContext` flush | Hold `checkpoint_active` across batch resolves; one outer drain after |
| Script eval watchdog | Longer caps for SPA-shaped URLs (`_next/static`, `webpack`, `chunk`) — framework path, not a single hostname |

No page-level JS shims. No “if fingerprint.com then …” in the microtask loop.

---

## Verification

```bash
cd /Users/huydev/Desktop/velora
zig build -Doptimize=ReleaseSafe
node scripts/cdp-fingerprint-playground-probe.mjs --max-sec 50
# Expect: push interceptor installed, window.next.router present, no immediate shell-only stall
# OfflineAudio smoke:
#   velora fetch --wait-ms 3000 --dump html http://127.0.0.1:8765/oac-fp.html
```

Pass criteria for this note: Next router + React fiber attach without host-specific shims; OfflineAudio standalone does not segfault.

### Follow-up (2026-07-17 evening): timer UAF

lldb after router boot:

```text
ScheduleCallback.deinit → ArenaPool.release  (x8=0 @ +0x28)
```

`ScheduleCallback` lived **inside** the tiny timer arena; `deinit` released that arena (and a second finalizer/run path double-freed). Fix: allocate the control block on the **realm arena**; optional params use a separate tiny arena; `released` flag; no host-gated `pumpDueTimersNow`.

After that fix: **no segfault for 40s**, Next `router` stable, OfflineAudio runs, agent script + `…/e?region=us` fetch return 200. Visitor ID table still not painted — agent collection likely stalls before result POST (separate core investigation).

---

## Lessons

- **Never host-gate microtask drainage** — SPA bootstrap is framework-shaped, not domain-shaped.
- **Classic scripts under kExplicit microtasks must same-turn drain** while `currentScript` is set; lifecycle evaluate() is exactly when SPAs need it most.
- **Promise resolve from native microtasks must not nest a full runMicrotasks** without `checkpoint_active` — batch under the flag, drain once.
- Prefer fixing webpack/Next **patterns** (`_next/static`, classic async chunks) over per-demo allow-lists.
