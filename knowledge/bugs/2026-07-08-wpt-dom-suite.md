# WPT DOM Suite — collections, iterators, CharacterData, exceptions

> **Date:** 2026-07-08 · **Area:** DOM / Web API bindings · **Status:** Incremental fixes per sub-suite

## Summary

July 2026 DOM WPT work targeted **live collections**, **TreeWalker / NodeIterator**, **DOMTokenList**, **CharacterData UTF-16 mutations**, **AbortSignal.reason**, and **microtask exception propagation** after collection traversal. Each area had distinct binding or lifecycle bugs rather than one shared root cause.

## Problem

| Suite area | Symptom |
|------------|---------|
| Collections / events | `HTMLCollection` live updates; `item()` after structural changes |
| NodeIterator / TreeWalker | Wrong root; `AbortSignal.reason` on detach |
| DOMTokenList | `supports()` / iteration edge cases |
| CharacterData | `spliceUTF16` SSO UAF; UTF-16 code unit vs scalar semantics |
| Exceptions | Microtask drain dropped DOMException type; cross-realm propagation |

## Root Cause themes

1. **TAO / wrapper mismatches** — iterator objects not tied to document lifetime.
2. **UTF-16 storage** — Zig string SSO paths aliased freed buffers after `deleteData`/`insertData`.
3. **Exception mapping** — V8 throw used generic `Error` where WPT expects `DOMException` name/code.
4. **Microtask ordering** — traversal callbacks scheduled work that ran after collection invalidation.

## Solution pattern

- Guard iterators when document navigates or node is removed.
- Copy UTF-16 mutation results into owned buffers before returning to JS.
- Route DOM bindings through `DOMException` factory with correct `.name` / `.code`.
- Drain microtasks at safe checkpoints after synchronous traversal steps.

## Lessons Learned

- DOM WPT failures are **localized** — batch by API family (collections vs CharacterData) not single “DOM fix”.
- **SSO UAF** shows up only on long UTF-16 strings — always test with non-SSO lengths.
- Pair DOM fixes with **exception propagation** tests — many suites assert both behavior and error type.

## References

- `src/core/dom/`, `src/core/webapi/element/`, `src/core/js/Env.zig`
- WPT: `/dom/`

## Related Knowledge

- [`2026-07-05-wpt-async-error-handling-batch.md`](2026-07-05-wpt-async-error-handling-batch.md) — microtask / `onerror` infrastructure
- [`2026-07-07-iframe-unload-visibilitychange-lifecycle.md`](2026-07-07-iframe-unload-visibilitychange-lifecycle.md) — document lifecycle (merged topic: iframe unload)