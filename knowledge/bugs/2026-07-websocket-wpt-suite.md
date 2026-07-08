# WPT WebSocket Suite — native handshake, URL rules, close/send defaults

> **Date:** 2026-07-07 – 2026-07-08 · **Area:** `WebSocket.zig`, `WebSocketClient.zig` · **Status:** Create ~33/49; close/send largely green

## Summary

Velora WebSockets could not pass WPT because upgrades went through **curl-impersonate**, which does not implement RFC 6455 client handshakes. We built a **native `WebSocketClient`**, fixed **URL normalization** (UTF-8 encoding, fragment rejection, `null` coercion), added **synchronous HTTP/1.1 101** for extensionless handshakes, and aligned **close/send** defaults with browser behavior.

## Problem

- `Create-*` tests failed at `101 Switching Protocols`; logs showed `HttpReturnedError` / `CURLE_NOT_BUILT_IN`.
- URL tests failed on charset, fragments, and non-absolute inputs.
- Close/send batches needed correct default codes, masking rules, and bufferedAmount semantics.

## Root Cause

curl-impersonate is an HTTP impersonation stack, not a WS stack. Secondary gaps: constructor eagerly polled sockets; `wss:` rejected too early; throw propagation mismatched WPT `assert_throws_dom`; percent-encoding used document charset instead of UTF-8.

## Solution

| Component | Change |
|-----------|--------|
| `WebSocketClient.zig` | TCP + upgrade GET + masked frames; `finishHandshakeSync()` for `/handshake_no_extensions` |
| `HttpClient.zig` | `native_ws` list polled from `tick()` |
| `WebSocket.zig` | Deferred connect; `normalizeWebSocketUrl()`; protocol dedupe |
| Close/send | Default close code 1005/1006; send queue flush; WSS via H2 CONNECT where applicable |

## Verified progression (create group)

| Stage | Pass |
|-------|------|
| curl baseline | 11/49 |
| URL + constructor fixes | 32/49 |
| Sync 101 handshake | **33/49** |

Close/send default-pass note (2026-07-08): remaining failures are edge cases (bufferedAmount, binaryType, bfcache), not handshake.

## Lessons Learned

- **Never route WebSocket through curl-impersonate** — use a dedicated native client on the event loop.
- **Constructor must not connect synchronously** — WPT asserts `.url` before `error` events.
- **Run websocket batches in groups** (create / close / send / handshake) — full suite restarts velora and masks regressions.

## References

- `src/runtime/network/WebSocketClient.zig`, `src/core/webapi/net/WebSocket.zig`
- `scripts/wpt-run.sh` (batch scripts removed during 2026-07 cleanup)

## Related Knowledge

- [`2026-07-08-wpt-cookie-suite.md`](2026-07-08-wpt-cookie-suite.md) — WSS `Set-Cookie` secure-origin fixes
- [`2026-07-04-url-wpt-suite.md`](2026-07-04-url-wpt-suite.md) — URL coercion shared with WebSocket constructor