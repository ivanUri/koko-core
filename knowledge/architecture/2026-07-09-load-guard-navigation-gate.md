# LoadGuard + navigation teardown gate

## Summary

Koko now uses a unified stale-load cancellation pattern for HTTP terminal callbacks (done / error / shutdown). Script, Image, and Link subresource loads capture a `TaskOwner` at request start via `LoadGuard.Guard`. Document navigation captures `_nav_task_owner` on each `navigate()`. `Session.canDestructivelyTeardown()` gates pending-root commit and deferred commit.

Site JS errors surface in the console without killing the process. Process crashes on re-navigate were engine lifecycle bugs (UAF / double-free on aborted HTTP callbacks), not site script failures.

## Components

| Piece | File | Role |
|-------|------|------|
| `LoadGuard.Guard` | `src/core/browser/LoadGuard.zig` | `task_owner`, `finished`, `isDeliverable` / `isDeliverableForRealm`, idempotent `finish()` |
| Script / Image / Link | `ScriptManagerBase.zig`, `Image.zig`, `Link.zig` | `guard` on each load; `shutdown_callback`; terminal callbacks check deliverability first |
| Frame nav | `Frame.zig` | `_nav_task_owner`; `navDeliverable()` uses realm fields (no `Execution` deref on dead frames); skip `error.Abort` |
| Teardown gate | `Session.zig` | `canDestructivelyTeardown(frame_id)`; used in `drainDeferredCommit` and `frameHeaderDoneCallback` |
| Stress probe | `code-check/site-stability/stress-renavigate.mjs` | Rapid re-nav after `Page.loadEventFired`; `npm run site:stability:stress` |

## Key rules

1. **Terminal callbacks only** — stale checks run on done / error / shutdown, not per-chunk `data_callback`.
2. **No Execution deref on dead realms** — use `isDeliverableForRealm` with `frame._realm_epoch` / `_realm_state` when the frame may be draining or dead.
3. **Abort is not an error page** — `frameErrorCallback` returns early on `error.Abort` (expected during re-navigate).
4. **Do not pump workers from script `evaluate` defer** — `Worker.pumpMessageDelivery` there caused NodeList double-release on BBC re-navigate.

## Verification

```bash
cd /Users/huydev/Desktop/koko
zig build
node code-check/site-stability/debug-reload.mjs "https://www.bbc.com/news"   # 2/2, koko alive
node code-check/site-stability/stress-renavigate.mjs --cycles 15             # 15/15, 100% pass
```

## Related

- [`knowledge/bugs/2026-07-09-renavigate-page-teardown.md`](../bugs/2026-07-09-renavigate-page-teardown.md) — NodeList teardown + `attribution_frame` abort
- [`knowledge/bugs/2026-07-09-worker-deferred-script-and-image-arena.md`](../bugs/2026-07-09-worker-deferred-script-and-image-arena.md) — prior BBC-specific script arena fixes