# MCP `goto` returned success with empty DOM

> **Audience:** Koko engineers using `koko mcp` (Cursor MCP, stdio tools).

## Summary

MCP `goto` / `navigate` reported success while `document.readyState` stayed `"loading"` and `document.body` was empty. The same URL loaded correctly via `koko serve` + CDP (`readyState: complete`, full HTML within ~1s for `https://github.com/`).

Root cause: `Runner._tick` for the non-CDP path (`runner.wait`, used by MCP) returned `.done` as soon as `http_active == 0` during in-flight navigation, **before** deferred HTML parse ran. `drainDeferredDocumentParse` was CDP-only, so MCP never promoted the downloaded document into the DOM.

## Problem

| Observation | Meaning |
|-------------|---------|
| MCP `goto` → success, `url` correct, `bodyLen: 0` | Navigation started; lifecycle never finished |
| CDP `Page.navigate` on same binary OK | Core fetch/parse/script path works |
| `waitForSelector` on localhost HTML OK | Simple sync pages masked the bug |

## Root Cause

In `Runner.zig`, non-CDP ticks hit an early return while `_parse_state` was still `.html` and `http_active == 0`:

```text
HTTP completes → scheduleDeferredDocumentParse (async)
runner.wait (MCP) → http_active==0 → return .done immediately
→ deferred parse never drained → empty document, loading forever
```

`drainDeferredDocumentParse` was gated with `if (comptime !is_cdp) return;`, so only the CDP server loop could finish the parse chain.

## Solution

`src/core/browser/Runner.zig`:

1. **Always** run `drainDeferredDocumentParse` (remove CDP-only guard).
2. In the non-CDP early-return branch, drain deferred parse first; only return `.done` when `_parse_state == .pre` and no deferred/active parse work remains.

No MCP-specific workaround (`waitCDP`) needed — `performGoto` keeps using `runner.wait`.

## Verification

```bash
cd /Users/huydev/Desktop/koko
zig build
node -e "… koko mcp … goto https://example.com/ …"   # ~200ms, bodyLen 207
node -e "… koko mcp … goto https://github.com/ …"    # ~9s, bodyLen ~521k, rs complete
```

Restart the MCP server (Cursor reload / restart `koko mcp`) to pick up the rebuilt binary.

## References

- `src/core/browser/Runner.zig` — `drainDeferredDocumentParse`, `_tick` non-CDP branch
- `src/protocols/mcp/tools.zig` — `performGoto`