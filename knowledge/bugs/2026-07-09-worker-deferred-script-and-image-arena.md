# Worker deferred script scheduling and image arena double-free on re-navigation

## Summary

Popular SPAs (Stack Overflow, Reddit, GitHub) crashed Velora during or after navigation when pages spawned dedicated `Worker`s or loaded many images. The failures were core lifecycle bugs: worker bootstrap scripts were queued on the **frame** scheduler (running inside DOM microtask checkpoints → SIGSEGV), and `HTMLImageElement` HTTP completions could **double-release** the same scratch arena on re-navigation (ArenaPool panic).

Fixes move worker deferred eval to the **worker** scheduler, pump worker tasks after classic script eval, cancel stale worker deferred tasks on `Worker.destroy()`, and make image/preload load callbacks idempotent with `isGoingAway()` guards.

## Root Cause

1. **Worker deferred scripts on frame scheduler** — `scheduleDeferredBlobScript` / `scheduleDeferredFetchedScript` used `frame.js.scheduler` for dedicated workers. Those tasks could run during `appendChild` → `drainMicrotasksAfterDomInsertion`, nesting worker V8 entry inside a frame checkpoint (`DisallowJavascriptExecution` / SIGSEGV). Shared workers already used `worker_scope.js.scheduler` for this reason.

2. **Image.load arena double-free** — `ImageLoad.finish()` always called `frame.releaseArena`. Abort + error path during `commitPendingPage` could invoke finish twice or race teardown, triggering `ArenaPool: double-free detected` (observed on Reddit run 2).

3. **MutationObserver API drift** — incomplete `notifyAttributeChange` signature left `Frame.zig` passing `self` as `attribute_namespace`, breaking builds.

## Solution

| Area | File | Change |
|------|------|--------|
| Worker defer | `Worker.zig` | Queue blob/fetched scripts on `worker_scope.js.scheduler`; `cancelDeferredScriptTasks` on destroy |
| Scheduler | `Scheduler.zig` | `cancelTasks(matcher)` to drop pending worker defer callbacks |
| Script pump | `ScriptManagerBase.zig` | `Worker.pumpMessageDelivery(frame)` after script eval pump |
| Image HTTP | `Image.zig`, `Link.zig` | `arena_released` guard; skip DOM work when `frame.isGoingAway()` |
| MO notify | `Frame.zig` | Pass `null` namespace to `notifyAttributeChange` |

## Verification

```bash
cd /Users/huydev/Desktop/velora
zig build
node code-check/site-stability/run.mjs --repeats 2
```

After fixes: **8/10** sites pass 2/2 (example, jsonplaceholder, wikipedia, github, hn, stackoverflow, mdn, reddit). BBC remains intermittently unstable (segfault under load). Amazon returns a bot-wall skeleton (~2 KB) — external, not an engine crash.

## References

- Probe harness: `code-check/site-stability/`
- Worker scheduler comment (shared mode): `Worker.zig` `scheduleDeferredFetchedScript`