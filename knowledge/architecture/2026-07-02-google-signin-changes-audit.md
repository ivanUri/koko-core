# Google Sign-In Changes — Architecture Audit (2026-07-02)

> **Status:** Login outcome fix **shelved**. This document classifies the diff from the sign-in investigation and records the architecture cleanup applied today.

## Summary

The Google Accounts sign-in work touched ~49 files. Some changes are correct engine/spec fixes; others were debug probes or experimental shims that leaked into production paths. We centralized sign-in instrumentation in `GoogleSigninDebug.zig`, env-gated all page-mutating shims, and reverted local profile cookie noise. **We are not continuing RTT/outcome fixes until explicitly reopened.**

---

## Keep — correct architecture / spec

| Area | Change | Why keep |
|------|--------|----------|
| **XHR** | `readystatechange` at `readyState=3` during LOADING; `getAllResponseHeaders` when `rs≥2` | Matches browser spec; required for progressive batchexecute handlers |
| **ScriptManagerBase** | `drainOrderedAsyncScripts` — async boq scripts run in insertion order | Fixes race where boq chunks evaluated before parent IIFE finished |
| **Frame** | iframe `about:blank` synchronous load; `isGoogleKnitsailHost` excludes `accounts.google` | Fingerprint/perf compat without polluting sign-in host |
| **HttpClient + Session** | `skip_xhr`, `protect_from_abort`, `hasProtectedTransfersForFrame` | Prevents navigation from aborting in-flight batchexecute (MI613e chain) |
| **Factory** | credential/authenticator/taskSignal helpers | Web API surface Google sign-in expects |
| **Performance** | `setIntegerNowMs` for `accounts.google` | Timing compat for Google's `performance.now()` checks |
| **Boq shims (always on)** | `boq_module_shim`, `boq_zc_shim` via `GoogleSigninDebug.prependBoqEvalShim` | Module-order and protobuf int rounding — not debug |

---

## Debug — must be env-gated (now centralized)

All flags live in `src/core/browser/GoogleSigninDebug.zig`. Probe mirror: `scripts/lib/google-signin-boq-closure-hook.mjs`.

| Env | Purpose | Default |
|-----|---------|---------|
| `KOKO_SIGNIN_CLOSURE_BUS_LOG=1` | Closure bus / `_.Wm` / UGa instrumentation | off |
| `KOKO_SIGNIN_RIB_LOG=1` | `rib.sya` / `rib.jya` wrap via `_.Nt` hook | off |
| `KOKO_SIGNIN_BIO_SHIM=1` | Experimental bio debounce shim (patches `setTimeout`/XHR) | **off** |
| `KOKO_SIGNIN_HTTPPRM_TRACE=1` | httprm delivery log + MI613e body prefix trace | off |
| `KOKO_BATCHEXECUTE_SYNC_DELIVERY=1` | Skip `deferred_delivery` ablation | off |
| `KOKO_SIGNIN_HTTPPRM_RTT=<ms>` | Parametric browserinfo httprm RTT sweep | unset |

**Architecture rule:** production navigation must not eval debug JS unless the matching flag is set.

---

## Fixed today — hash / wrong architecture

1. **Bio shim always on** — `injectGoogleAccountsBioShim` ran on every `accounts.google` navigation. Now gated by `GoogleSigninDebug.bioShimEnabled()` (`KOKO_SIGNIN_BIO_SHIM=1`).

2. **MI613e trace always on** — `XMLHttpRequest.send` logged body prefix unconditionally. Now gated by `GoogleSigninDebug.mi613eTraceEnabled()` (same env as httprm trace).

3. **Duplicate hook strings** — ~120 lines copied between `Frame.zig` and `ScriptManagerBase.zig`; `ScriptManagerBase` imported `Frame.google_signin_closure_bus_script` (circular coupling). Removed duplicates; both call `GoogleSigninDebug`.

4. **Duplicate httprm trace env** — `HttpClient.zig` had its own `signinHttprmTraceEnabled()`. Now uses `GoogleSigninDebug.httprmTraceEnabled()`.

---

## Shelved — do not merge as production behavior

| Item | Notes |
|------|-------|
| **Login outcome (`2,2,2` → `/rejected`)** | Post-`_.Wm` fix: `rib.sya` runs but RTT bucket stays `2` (~38–48 ms; need >250 ms for bucket `1`). RTT sweep / UEkKwb boost intentionally not pursued. |
| **HttpClient httprm RTT boost** | Research helpers remain env-gated (`KOKO_SIGNIN_HTTPPRM_RTT`); UEkKwb/browserinfo intentionally not boosted. |
| **`deferred_delivery`** | `KOKO_BATCHEXECUTE_SYNC_DELIVERY=1` ablation only; default path unchanged. |

---

## Reverted / do not commit

```bash
git checkout -- browser/profiles/assets/chrome-local-huys-macbook-pro-session-cookies.json \
  browser/profiles/sessions/chrome-local-huys-macbook-pro-cookies.json \
  browser/profiles/sessions/chrome-local-huys-macbook-pro-cookies.json.storage.json
```

Untracked profile backups and guest probe JSON under `browser/profiles/` — local artifacts only.

---

## Unrelated diff (out of scope for sign-in audit)

- Wikipedia bench (`code-check/bench/crawl-wikipedia-*`), `package.json` scripts
- `sdk/src/browser/google-search.ts` `waitUntil` `done`→`load` (SDK; paused per project rule)

---

## Module layout (after cleanup)

```
GoogleSigninDebug.zig
  ├── env helpers (closureBus, rib, bio, httprm)
  ├── JS strings (closure_bus, bio_shim, closure_hook_inline, rib_hook_inline, boq shims)
  ├── injectBoqIifeHooks()
  └── prependBoqEvalShim()   ← ScriptManagerBase calls this during sync parent eval

Frame.zig
  ├── injectGoogleSigninClosureBusLog()  ← navigate + post-parse, env-gated
  └── injectGoogleAccountsBioShim()      ← env-gated (KOKO_SIGNIN_BIO_SHIM)

ScriptManagerBase.zig
  └── boq classic eval → prependBoqEvalShim + boq_zc_shim post-eval

HttpClient.zig / XMLHttpRequest.zig
  └── httprm + MI613e trace via GoogleSigninDebug env only
```

---

## Resuming probes (when user reopens sign-in work)

```bash
cd /Users/huydev/Desktop/koko
KOKO_BATCHEXECUTE_SYNC_DELIVERY=1 \
KOKO_SIGNIN_CLOSURE_BUS_LOG=1 \
KOKO_SIGNIN_RIB_LOG=1 \
GOOGLE_SIGNIN_PROBE_EMAIL='…' \
  node scripts/cdp-google-signin-xhr-dispatch-gap.mjs \
  --profile chrome-local-huys-macbook-pro --koko-only --max-sec 55
```