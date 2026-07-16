# Google Search: Knitsail DCL must fire during parse, not after full HTML drain

> **Audience:** Velora engineers working on Google `/search` antidetect and CDP lifecycle parity.  
> **Symptoms:** `Page.domContentEventFired` never fires within 20s; `document.readyState` stays `"loading"` while title/body already show bootstrap HTML; `chrome.csi().pageT` climbs to 10s+ instead of ~192ms; Puppeteer/SDK `waitUntil: "domcontentloaded"` times out.

## Summary

Google Search cold-tier bootstrap (~91KB HTML with Knitsail VM) stalled Velora's document lifecycle. The prior fix deferred DCL to `Frame.pumpPostParseTasks` after deferred HTML parse completed. On live `/search`, html5ever + parser-inserted scripts blocked for 10–15s before `parse html done`, so DCL and `pageT` freeze never ran in the window Knitsail reads (~200ms per [SerpBase Knitsail analysis](https://serpbase.dev/blog/google-knitsail-and-sg-ss-generation-logic-and-its-role-in-distinguishing-automa)).

The fix fires Knitsail lifecycle **during parse**: after the first parser-inserted script (or a 250ms fallback), run timer milestones (t20/t80/t200), freeze `performance.now()` / `chrome.csi().pageT` at ~192.6ms, and call `documentIsLoaded()`. `sg_ss` microtasks remain deferred via `_defer_knitsail_post_parse` until post-parse `pumpPostParseTasks`.

Verified on `https://www.google.com/search?q=lightpanda`: DCL ~355ms, `readyState=interactive`, `pageT=192.59999999403954`, `trustedTypes` present.

---

## Problem

| Signal | Broken Velora | Expected (Chrome / SerpBase) |
|--------|---------------|------------------------------|
| `Page.domContentEventFired` | absent 8–15s | ~300–500ms |
| `document.readyState` | `"loading"` | `"interactive"` before Knitsail VM encode |
| `chrome.csi().pageT` | wall-clock 5–15s | frozen ~192.6ms at encode |
| `performance.now()` texture | monotonic wall ms | milestone jitter + freeze |

SerpBase documents that Knitsail VM reads `performance.now()`, `performance.timing`, `document.readyState`, and `window.trustedTypes` to score environment authenticity. Static spoofing without natural lifecycle timing is a bot signal.

---

## Root Cause

1. **DCL gated on post-parse pump.** `pumpPostParseTasks` ran only after `DeferDocumentParseCallback` finished html5ever on the full document. Google bootstrap parse + in-parser script eval took >>200ms.

2. **Knitsail `tailHook` intentionally skipped DCL** (defer `sg_ss` microtasks), relying on the post-parse pump that arrived too late.

3. **`evaluate()` after parse** could still block on incomplete `defer` heads, but the dominant failure was never reaching the pump while `readyState` stayed `loading`.

---

## Solution

### `Frame.zig`

- Track `_knitsail_lifecycle_pumped`, `_knitsail_parser_script_seen`, fallback scheduler.
- `noteKnitsailParserScript()` + `tryPumpKnitsailDocumentLifecycle()`:
  - inject bootstrap globals
  - `pumpKnitsailTimerMilestones` (22.6 / 82.4 / 165.1ms)
  - `freezeNow(192.59999999403954)`
  - `documentIsLoaded()` while `_load_state == .parsing`
  - keep `_defer_knitsail_post_parse = true` for sg_ss microtask hold
- Call from `ScriptManagerBase` script defer pump when `isGoogleKnitsailHost && isDocumentParsing`.
- Schedule `KnitsailLifecycleFallbackCallback` at 250ms from `navigate()` if no parser script noted.
- `pumpPostParseTasksNow`: idempotent — drain sg_ss microtasks after parse if lifecycle already pumped.

### `ScriptManager.zig`

- `tailHook` for knitsail: still defers sg_ss; DCL no longer depends on `tailHook`.

---

## Verification

```bash
cd /Users/huydev/Desktop/velora && zig build
# CDP probe: Page.domContentEventFired < 1s, pageT ≈ 192.6, readyState interactive
```

Probe result (2026-07-15):

```json
{
  "dclMs": 355,
  "readyState": "interactive",
  "pageT": 192.59999999403954,
  "hasTrustedTypes": true
}
```

---

## Follow-up (scope + general DCL stalls)

Bench vs [Lightpanda urls-100](/Users/huydev/Desktop/lightpanda/logs/run-2026-07-14T17-01-44): **38 URLs** LP-ok / Velora-fail shared one dominant error — `Waiting for Page.domContentEventFired` (19×). That is the same lifecycle class as the original knitsail bug (`evaluate()` never reaches `tailHook`), not unrelated regressions from the knitsail patch.

To avoid affecting non-Search Google pages:

- `isGoogleKnitsailHost` now requires `/search` (homepage / Identity use normal `tailHook` DCL).

For non-knitsail sites (ebay, wikipedia, rust-lang, …), Velora's deferred-parse + CDP interleave can stall on incomplete `defer` heads longer than Lightpanda's synchronous `frameDoneCallback → staticScriptsDone` path:

- `defer_head_stall_timeout_ms` (3.5s): drop incomplete defer head, continue to DCL.
- Lifecycle script eval watchdog extended (5–6s) for post-parse `evaluate()`.

## Lessons

- Knitsail antidetect is a **lifecycle-timing** problem, not only a post-load script problem.
- Do not tie CDP `domContentLoaded` to full html5ever completion on Google `/search`.
- Separate concerns: **DCL + pageT freeze** (VM read window) vs **sg_ss microtask drain** (post-parse).
- Scope knitsail-only hooks narrowly (`/search`); keep LP-like `tailHook` DCL for everything else.
- Many bench DCL failures are one root cause: **lifecycle resume stalled**, not per-site one-offs.