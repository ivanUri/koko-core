# CDP parity gaps closed (Emulation, Fetch, Network, LP)

## Summary

Koko's CDP surface had several no-op or blocking gaps that broke Playwright-shaped clients: viewport overrides did nothing, `Koko.clickNode` could hang on human pointer animation, permissions and navigator emulation were not wired, and Network/Fetch events were incomplete. This change implements the missing Emulation state, fast Koko activation, Browser permissions, navigator emulation overrides, Network extraInfo events, Input optional params, Fetch stale-intercept handling, DOM getContentQuads for document/text, isolated-world context recreation, and SDK `page.route()`.

Build verified with `zig build check` and `npm run build` in `sdk/`.

---

## Problem

| Gap | Impact |
|-----|--------|
| `Emulation.setDeviceMetricsOverride` noop | `page.setViewportSize()` had no effect |
| `Koko.clickNode` + `HumanInput.movePointerTo` | CDP clients timed out on agent clicks |
| Browser permissions noop | `grantPermissions` did not affect `navigator.permissions` |
| Missing Network extraInfo | Clients expecting paired events saw incomplete traces |
| Fetch intercept after navigation | Stale `requestId` replies could error or UAF |
| SDK missing `page.route()` | README documented gap; no interception helper |

---

## Fix

- **`EmulationState.zig`**: per-`BrowserContext` overrides (viewport, touch, timezone, locale, geo, permissions).
- **`Frame` / `Window` / `VisualViewport`**: read emulation via `session.emulation`.
- **`InputController.dispatchActivationOnElementFast`**: Koko clicks skip bezier pointer moves.
- **`browser.zig`**: `grantPermissions`, `resetPermissions`, `setPermission` store into emulation.
- **`NavigatorState` + `Permissions`**: language, platform, maxTouchPoints, permission query respect emulation.
- **`network.zig`**: emit `requestWillBeSentExtraInfo` / `responseReceivedExtraInfo`; set `hasExtraInfo` / `redirectHasExtraInfo`.
- **`fetch.zig` + `page.zig`**: clear intercepts on navigation; stale replies return success noop.
- **`dom.zig`**: `getContentQuads` for document (viewport) and text nodes.
- **`CDP.zig` IsolatedWorld**: recreate context on navigation instead of reusing stale context.
- **`sdk/route.ts`**: Playwright-style `page.route()` / `unroute()` via `Fetch.enable`.

---

## Verification

```bash
cd /Users/huydev/Desktop/koko
zig build check
cd sdk && npm run build
```