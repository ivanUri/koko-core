# WPT Workers Suite — dedicated, shared, modules, credentials, messaging

> **Date:** 2026-07-05 – 2026-07-06 · **Area:** `Worker.zig`, `SharedWorker`, module loaders · **Status:** Dedicated modules green; SharedWorker partial

## Summary

Worker WPT coverage required fixes across **constructor shims**, **global exposure**, **`importScripts` error propagation**, **module `import()`**, **credentials + cookies on loopback**, **structured clone / transferables**, **runtime `error` events**, and **SharedWorker** CDP/TAO plumbing. Fifteen incremental notes are consolidated here.

## Problem clusters

### Dedicated workers
- Classic + module workers missing `onerror` / `runtime-error` event paths.
- `importScripts` MIME and throw propagation (`application/javascript` vs `text/plain`).
- Module graph: wrong fetch credentials; `import()` ordering vs `export-on-load.js`.
- `postMessage` from page missed delivery when worker not yet listening.
- `FormData` / `ImageData` structured clone and transfer list support.

### Shared workers
- Constructor shim for empty `SharedWorker` (WPT expects object before connect).
- `connect()` SIGSEGV — dispatch from wrong thread / freed port.
- Global accessor TAO mismatch on `SharedWorkerGlobalScope`.
- `MessagePort` structured clone parity with dedicated workers.
- `-0` name normalization shim.

### Cross-cutting
- `WorkerGlobalScope` exposure list vs `wpt_only` snapshot gaps.
- Session deinit weak callback UAF during worker teardown.
- Loopback cookie same-site: `127.0.0.1` vs `www1.localhost` (see also cookie suite).

## Root Cause

Workers combine **new JS realms**, **separate network clients**, and **CDP session attribution**. Bugs clustered where Koko reused page-frame assumptions (cookies, incumbent settings, TAO pointers) inside worker contexts.

## Solution highlights

| Area | Fix |
|------|-----|
| Credentials | `shouldSendCookies` classic → same-origin only; module fetch credentials matrix |
| Cookies | `areSameSite` loopback alias; CDP duplicate Cookie dedupe |
| Errors | Propagate `importScripts` exceptions; `Worker` `error` event on script load fail |
| SharedWorker | Constructor + connect dispatch guards; port clone |
| Messaging | Page→worker queue until `message` listener installed |
| Lifecycle | Weak callback cleared before session deinit |

## Verified (representative)

| Test | Result |
|------|--------|
| `dedicated-worker-options-credentials.html` | 33/33 |
| `Module` dedicated import suites | majority green after credentials fix |
| SharedWorker classic | partial — connect/shim improved, full suite incomplete |

## Lessons Learned

- **Always test loopback WPT hosts** (`localhost`, `127.0.0.1`, `*.localhost`) as one matrix — cookie SameSite defaults break cross-origin import tests.
- **Worker errors need two paths** — exception at construction vs `error` event at runtime.
- SharedWorker remains **lower priority** than dedicated/module workers for antidetect use cases.

## References

- `src/core/webapi/Worker.zig`, `SharedWorker`, `DedicatedWorkerGlobalScope.zig`
- WPT: `/workers/`

## Related Knowledge

- [`2026-07-08-wpt-cookie-suite.md`](2026-07-08-wpt-cookie-suite.md) — jar + testdriver
- [`2026-07-05-wpt-async-error-handling-batch.md`](2026-07-05-wpt-async-error-handling-batch.md) — worker `onerror` / microtasks