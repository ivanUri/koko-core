# Bench url-100 lifecycle/CDP fixes (partial)

> **Date:** 2026-07-15 · **Area:** `ScriptManagerBase`, `Frame`, `HttpClient`, `Env` · **Status:** Partial — DCL gaps remain on go.dev-class sites

## Summary

Velora bench vs Lightpanda on `urls-100.txt` was ~59/102 OK. Work targeted the three failure classes: `Waiting for Page.domContentEventFired`, `Transport closed`, and CDP snapshot hangs.

## Root causes addressed

1. **`evaluatePendingWhenCentral` skipped incomplete defer heads** — stall/fallback timers never re-entered `evaluate()`.
2. **`blocksInboundCdp` gated on `is_evaluating`** — starved `Runtime.evaluate` between script slices.
3. **`serviceInboundCdpIfReadable` blocked inside transfer callbacks** — CDP never serviced during `frameDoneCallback` script drain.
4. **Stack overflow on GTM-heavy pages** — slice defer eval (`max_defer_evals_in_transfer_callback = 6`).
5. **HTML parse strategy** — inline parse ≤128KB; larger docs use deferred parse + `pumpDeferredDocumentParse`.

## Changes

- `ScriptManagerBase.zig`: `evaluatePendingWhenCentral` need clause; lifecycle fallback reschedule; `dropIncompleteLifecycleScriptHeads`; wall/stall timeout paths; `errorCallback` ghost-head cleanup; `realmParseComplete` pump; transfer-callback defer slice limit.
- `Env.zig`: remove `is_evaluating` from `blocksInboundCdp` (keep V8-on-stack + navigationCritical).
- `HttpClient.zig`: CDP service during transfer callback when V8 idle; `pumpDeferredDocumentParse`; public `pumpCdpMacrotasks`.
- `Frame.zig`: hybrid inline/deferred parse; more frequent `pollCdpDuringLongWork`.

## Verification

```bash
cd /Users/huydev/Desktop/velora && zig build
cd /Users/huydev/Desktop/velora-run && VELORA_BIN=../velora/zig-out/bin/velora node test-100-urls.mjs
```

Raw CDP probe on `https://go.dev/`: receives `Page.frameNavigated` but **no** `Page.domContentEventFired` within 15s — server-side lifecycle still incomplete after navigation commit.

## Remaining work

- go.dev / netlify / x.com: confirm `frameDoneCallback` → `staticScriptsDone` runs; trace why `documentIsLoaded` / CDP event not emitted.
- Reduce `Transport closed` regressions (12 on one full run) — likely eval stack / timer pumps on heavy GTM.
- Re-benchmark with `ReleaseSafe` binary for fair comparison.