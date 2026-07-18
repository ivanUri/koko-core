# Host event architecture: JsEntryGate + EventLoop + NetworkLedger

> **Audience:** Velora engineers.  
> **Status:** **v1.0 browser-minimum achieved** (D1–D7 verified offline 2026-07-19).  
> **Not:** Lightpanda HttpClient port; site URL specials in `src/core`; product demos as DoD.

## Browser-minimum DoD (v1.0)

| # | Criterion | Status |
|---|-----------|--------|
| D1 | Wait spine: Runner waitFor* keeps spinning on idle; Runner/CDP use EventLoop.spin | **done** |
| D2 | JsEntryGate for MessagePort + Timers; Worker already scheduler-queued | **done** (Worker pre-aligned) |
| D3 | Fetch `httpDoneCallback` only `scheduleDeferredFetchDone`; settle on task path | **done** |
| D4 | Nested drains via EventLoop (`isHostNested`, `afterDomMutation`) | **done** |
| D5 | HostIdle for Runner + CDP page lifecycle | **done** |
| D6 | EL-A…G + lint offline | **done** |
| D7 | `npm run test:event-loop:cdp` (EL-A + EL-E under serve) | **done** |

```bash
zig build check && zig build
npm run test:event-loop
npm run test:event-loop:cdp
npm run lint:no-site-specials
```

## Summary

SPA/React/Next hangs (and Fingerprint playground “no Visitor ID”) were addressed with per-API pumps and `fingerprint.com` branches. That is tip-level. This ADR freezes that culture and defines a **Velora-native** host architecture:

1. **`JsEntryGate`** — one answer to “may I run script / dispatch a host event *synchronously*?”
2. **`EventLoop`** — shared spin/afterTask on top of existing `Context.scheduler` (no second queue yet).
3. **`NetworkLedger` / HostIdle** (later phase) — one idle formula for Runner + CDP.

Constraints we **keep** (not LP): no user JS inside curl transfer callbacks; `ready_queue`; ScriptManager `canEval` / central-stack rules.

## Principles

1. HTML-shaped event loop: APIs enqueue; the loop runs tasks + microtask checkpoints.
2. Queued tasks must not re-apply “sync nested” gates when they fire.
3. No `fingerprint.com` / site URL branches in `src/core`.
4. Fixtures (MessageChannel chain, etc.) gate merges—not production URL probes alone.

## Policy table (sync host event / Script.eval)

| Situation | Sync host event | Script.eval |
|-----------|-----------------|-------------|
| Curl `inTransferCallback` | no | no |
| `anyContextOnV8Stack` / `call_depth > 0` | no | no |
| `ScriptManager.is_evaluating` | no (queue) | no nested |
| Task runner after gates clear | yes | yes |

## Module map

| Module | Path | Role |
|--------|------|------|
| JsEntryGate | `src/core/js/JsEntryGate.zig` | `canDispatchHostEventSync`, `mustQueueAsTask` |
| EventLoop | `src/core/js/EventLoop.zig` | `afterTask`, `spinOnce`, `spin`, `spinUntil`, `drainMicrotasksNested` |
| HostIdle | `src/core/browser/HostIdle.zig` | idle / done predicates for Runner + CDP |

### Covered APIs (v0.2)

| API | Gate | EventLoop |
|-----|------|-----------|
| MessagePort | yes | `afterTask` on task path |
| Timers (nested short delay) | yes | `drainMicrotasksNested` + deferred pump |
| Fetch deferred continue | task-path spin | `EventLoop.spin` |
| Runner wait edge | — | `spin` after macrotasks |
| DOM / iframe mutation | — | `afterDomMutation` (nested vs top-level) |

### Nested vs top-level drains (WS3 / PR-C)

| API | Nested host stack | Top-level |
|-----|-------------------|-----------|
| `EventLoop.drainMicrotasksNested` | checkpoints + schedule deferred pumps only | same (never timers) |
| `EventLoop.afterDomMutation` | = nested drain only | nested drain + `pumpDueTimersNow` + `spin` |
| `EventLoop.afterTask` / `spin` | no-op / nested drain | `runOne` + microtasks |
| `Frame.pumpSameTurnPromiseContinuations` | no `pumpDueTimersNow` | may runOne + short timers |
| `Frame.drainClassicScriptMicrotasks` | mid-script checkpoints only | — |
| `Frame.pumpDueTimersNow` | **refuses** if `isHostNested` → deferred pump | runs due tasks |

`Env.drainNestedHostMicrotasks` is a **thin wrapper** around `EventLoop.afterDomMutation` — do not add logic there.

### Merge checklist

```bash
zig build check
zig build   # binary for fixtures
npm run test:event-loop
npm run lint:no-site-specials
```

## Migration checklist

See `knowledge/architecture/2026-07-19-host-event-loop-inventory.md`.

## Phases

- **P0** ADR + rules + inventory (this doc) — **done**.
- **P1** Gate + MessagePort + fixtures EL-A/B — **done**.
- **P2** EventLoop.spin on Browser/Runner/CDP; remove FP site branches — **done** (2026-07-19).
- **P3** HostIdle (NetworkLedger-thin) — **done** (`src/core/browser/HostIdle.zig`).
- **P4** EL-A…E offline suite — **done**.
- **v0.2 P5** `spinUntil` + Runner wait-edge spin — **done**.
- **v0.2 P6** Timers + Fetch settle on Gate/EventLoop — **done** (Worker pumps on Gate too).
- **v0.2 P8** `npm run test:event-loop` + `lint:no-site-specials` — **done**.
- **v0.2 P9** EL-F client-bailout router fixture — **done**.
- **v0.2 P7 / PR-C** nested drain collapse — **done** (`afterDomMutation`, `isHostNested`, `pumpDueTimersNow` gated).
- **v0.2 P10** Close-out (2026-07-19): collapse iframe settle chain; Gate on Worker/Window/Timers; Scheduler re-arm priority flag; `prefer_http3` on NavigationPlan (no Google URL match in HttpClient).
- **v0.2 P11** Land + harden: EL-H/EL-I fixtures; lint bans HttpClient host/path specials; `force_fresh_connection` on NavigationPlan (replaces `sg_ss=` URL check).

### P2 notes

- Renamed `drainFingerprintYbMicrotasks` → `drainNestedHostMicrotasks` (generic).
- Removed all `fingerprint.com` / `is_fp` **behavior** branches from `src/core` (comments in Fetch.zig may still mention playground as history).
- Post-script drainage uses `EventLoop.spin` without URL checks.
- Runner (not Browser.runMacrotasks) owns wait-edge `EventLoop.spin` to avoid double-spin.

## Review reject list

- New `if (url contains "fingerprint.com")` in `src/core`
- New private reentrancy triple in an API instead of JsEntryGate
- Copying LP `dispatch_queue` / `gated_queue` without a separate design review
- New host/path URL specials inside `HttpClient.configureConn` (use NavigationPlan / RequestParams flags)
- Dense multi-delay private settle storms (prefer EventLoop.spin + one re-arming task)
