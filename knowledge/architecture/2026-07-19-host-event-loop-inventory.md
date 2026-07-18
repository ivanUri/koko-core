# Host event loop migration inventory (2026-07-19)

Update when migrating call sites to JsEntryGate / EventLoop.

## Status legend

| Tag | Meaning |
|-----|---------|
| **done** | Uses JsEntryGate / EventLoop / HostIdle |
| **intentional** | Private check remains by design (documented) |
| **todo** | Still open-coded; migrate when touching the path |

## Core modules

| Module | Path | Status |
|--------|------|--------|
| JsEntryGate | `src/core/js/JsEntryGate.zig` | done |
| EventLoop | `src/core/js/EventLoop.zig` | done |
| HostIdle | `src/core/browser/HostIdle.zig` | done (thin) |

## Covered APIs (done)

| API | Gate | EventLoop / notes |
|-----|------|-------------------|
| MessagePort sync | `mustQueueAsTask` | task path: `dispatchMessageForced` + `afterTask`; flush re-park + `deferFlush` |
| Timers nested short delay | `mustQueueAsTask` | `drainMicrotasksNested` + deferred pump; delay coerce via Gate |
| Fetch settle | `inTransferCallback` | always scheduler task; `afterTask` / `spin` on continue |
| Runner wait edge | — | `EventLoop.spin`; HostIdle for done/networkIdle |
| DOM / iframe mutation | — | `afterDomMutation` / `isHostNested` |
| Frame `pumpDueTimersNow` | — | refuses when `isHostNested` |
| Frame iframe settle | — | nested microtasks only; top-level spin; **one** re-arming settle chain (0→10→50→200→1000) |
| Worker bootstrap pump | `mustQueueAsTask` | `pumpBootstrapContext` / `pumpMessageDelivery` |
| Window parent→child postMessage | `mustQueueAsTask` on target | defer reentrant reply |
| ScriptManager post-eval | — | `EventLoop.spin` + single `settleIframePromisesNow` |
| Env `drainNestedHostMicrotasks` | — | thin → `EventLoop.afterDomMutation` |
| CDP page lifecycle idle | — | `HostIdle.totalHttpActivity` |
| Scheduler re-arm priority | — | `Task.low_priority` flag (no name string match) |

## WS3 / PR-C — nested drain collapse

| Old | New |
|-----|-----|
| `Env.drainNestedHostMicrotasks` body | thin → `EventLoop.afterDomMutation` |
| Frame iframe flush / sync load | `EventLoop.afterDomMutation` |
| `Frame.drainMicrotasksAfterDomInsertion` | pumpSameTurn + `afterDomMutation` |
| `Frame.pumpDueTimersNow` | refuses when `EventLoop.isHostNested` |
| Nested microtasks only | `EventLoop.drainMicrotasksNested` |
| 12× `iframePromiseSettle` delays | 1 re-arming task (4 gaps) |

## Site specials

| Check | Status |
|-------|--------|
| `fingerprint.com` / `is_fp=` behavior in `src/core` | **removed** (lint: `npm run lint:no-site-specials`) |
| Comment-only FP mentions | allowed |
| Google cold search h3 | **relocated**: `NavigationPlan.prefer_http3` (search first hop), not `HttpClient` URL match |
| In-session force fresh | **relocated**: `NavigationPlan.force_fresh_connection` (`in_session`); HttpClient only reads flag |

## Intentional private checks (not full Gate)

| Site | Why |
|------|-----|
| `HttpClient.serviceInboundCdpIfReadable` | Only `anyContextOnV8Stack` — full Gate would starve CDP during `is_evaluating` |
| `Env.runMicrotasks` reentry / knitsail timer source | Microtask policy, not host-event dispatch |
| `Env.contextBlocksTimerPump` | Realm/lifecycle readiness for timer pump |
| `ScriptManagerBase.canEval` / `is_evaluating` windows | Script pipeline ownership |
| `Session` teardown vs `is_evaluating` | CDP reentrancy during page discard |

## Remaining optional migrations (todo, low priority)

| Site | Note |
|------|------|
| `HttpClient` other `anyContextOnV8Stack` if any | Prefer `JsEntryGate.anyV8StackActive` when on an Execution |
| Worker message paths beyond bootstrap pump | Already scheduler-queued for many paths |
| Expand lint to ban new host/path specials in `HttpClient` | Policy layer only |

## Merge / verify

```bash
zig build check && zig build
npm run test:event-loop
npm run test:event-loop:cdp
npm run lint:no-site-specials
```

## Follow-up completed 2026-07-19 (close-out)

- Collapse iframe settle storm
- Nested settle comment + `isHostNested` policy fixed
- Worker / Window / Timers → JsEntryGate
- Scheduler re-arm via `low_priority` flag
- Google h3 via NavigationPlan.prefer_http3
- This inventory refreshed (no longer lists dead `is_fp` call sites)
