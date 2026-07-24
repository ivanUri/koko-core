# Product WPT triage: Headers iterable, location.hash no-op, destroyContext idempotent

> **Audience:** Velora engineers  
> **Date:** 2026-07-23  
> **Scope:** Site-facing architecture only — not full WPT green, not `file://` edge corpus

## Summary

After a failed-only WPT re-run (~388 remaining non-pass), we fixed three **product-impact** issues and deliberately skipped low-value edges (`file://example.com`, bulk IDNA, full CORS preflight rewrite).

1. **`Headers` not iterable** — real sites use `for (const [k,v] of response.headers)`. Added `symbol_iterator` and Headers-only **sort-and-combine** iterators.
2. **`location.hash = ''` full reload** — same-URL no-op was missing; empty hash with no fragment fell through to network reload and hung SPA/WPT.
3. **`destroyContext` double-call panic** — Debug `@panic("Tried to remove unknown context")` killed the process during `document.open` / iframe teardown. Now idempotent (skip if already removed).

`document.open` still can crash later with **incorrect alignment** (UAF) — process no longer panics on double-destroy, but open/write remains a follow-up.

---

## Product vs park

| Fix | Why product | Skipped |
|-----|-------------|---------|
| Headers `@@iterator` + combine | Fetch Response.headers iteration | Full WPT headers matrix |
| Header name token validation | Throws on garbage names | `new Headers(null)` still open |
| location.hash / same-URL no-op | SPA hash routing | Nested iframe location matrix |
| destroyContext idempotent | Stability for open/nav | Full document.open rewrite |
| — | — | `file://` host edges, IDNA bulk, early-hints H2, CORS OPTIONS pipeline |

---

## Code

| File | Change |
|------|--------|
| `src/core/webapi/net/Headers.zig` | `symbol_iterator`, combined keys/values/entries/forEach, token validation |
| `src/core/webapi/KeyValueList.zig` | `nextCombined`, Combined* iterators registered |
| `src/core/webapi/Location.zig` | empty hash no-op when no fragment |
| `src/core/browser/Frame.zig` | same-URL scheduleNavigation no-op; fragment short-circuit simplified |
| `src/core/js/Env.zig` | destroyContext returns if context not registered |

---

## Verification

```bash
cd /Users/huydev/Desktop/velora && zig build
# targeted WPT (not full suite)
./scripts/retest-open.sh
```

Expect: headers combine iteration improved; process survives more teardown; open may still crash alignment until deeper fix.

---

## Follow-up (product)

1. **document.open/write UAF** — align crash after child iframe remove; need stack with unstripped debug.
2. **CORS preflight OPTIONS** — not implemented; needed for custom-header cross-origin APIs.
3. **Headers value validation** (non-token values) and `new Headers(null)`.
