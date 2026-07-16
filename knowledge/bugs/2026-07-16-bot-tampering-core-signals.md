# Bot / Tampering Core Signals — Window.webdriver, Touch, BotD Scrub

> **Date:** 2026-07-16 · **Area:** antidetect, BotD, Fingerprint Pro smart signals · **Status:** Verified via CDP probe

## Summary

Fingerprint Pro bot/tampering flags and Fingerprint **BotD** (OSS) both key off automation and consistency surfaces that FingerprintJS OSS does **not** implement as smart signals. Velora already spoofed `navigator.webdriver === false` and basic `cdc_` scrub, but still leaked **`'webdriver' in window`**, desktop **`ontouchstart` on Window**, missing **`productSub`**, and a thin automation scrub list.

This pass hardens **core-common** bot/tampering surfaces (no host-specific hashing): production snapshots omit `Window.webdriver` (`wpt_only`), Window `ontouch*` handlers are no longer always exposed, BotD-aligned scrub expanded, `productSub`/`vendorSub` match Chrome, and antidetect profile load validates platform × UA-CH arch × touch × PDF plugins.

Verified with `node scripts/cdp-bot-signals-probe.mjs --profile chrome-local-huys-macbook-pro` — all checks green.

---

## Problem

After SPA/microtask work, Fingerprint Pro playground still reported automation / tampering / low confidence. Mapping to **BotD** `distinctive_properties` and `product_sub` / `touch_support` (FPJS) showed concrete client leaks:

| Signal | Real Chrome (desktop) | Velora (before) |
|--------|----------------------|-----------------|
| `navigator.webdriver` | `false` | `false` |
| `'webdriver' in window` | **false** | **true** (testdriver accessor) |
| `'ontouchstart' in window` | **false** | **true** (always on Window.JsApi) |
| `navigator.productSub` | `"20030107"` | missing / undefined via keys stub |
| Automation markers | absent | only `cdc_` scrub |

BotD treats the **window** property name `webdriver` as WebDriver automation — independent of `navigator.webdriver`.

---

## Root Cause

1. **WPT testdriver vs production.** Cookie WPT needs `window.webdriver.deleteAllCookies()`. The accessor was registered **without** `wpt_only`, so every production snapshot exposed BotD’s distinctive WebDriver prop.

2. **Touch IDL always on.** Desktop Chrome omits Window `ontouch*` event handler properties. Velora registered them unconditionally → FPJS `touchSupport.touchStart` true with `maxTouchPoints: 0` (inconsistency / tamper-like).

3. **Incomplete scrub.** `AutomationScrub` only deleted `cdc_` / `$cdc_`. BotD also looks for Selenium/WebDriver/Phantom/Playwright document attributes and named globals.

4. **Missing BotD productSub.** Chrome productSub is the fixed string `20030107`.

5. **`chrome.runtime` deliberately omitted.** A naive function stub has `.prototype` and is constructable → CreepJS `hasBadChromeRuntime`. Omitting runtime remains safer than a lying runtime.

---

## Solution

| Layer | Change |
|-------|--------|
| `Window.zig` | `webdriver` accessor → `{ .wpt_only = true }`; remove always-on `ontouch*` accessors |
| `AutomationScrub.zig` | BotD-aligned window/document markers + cdc/selenium patterns + documentElement attrs |
| `Navigator` / `NavigatorState` / `WorkerNavigator` | `productSub` = `20030107`, `vendorSub` = `""` |
| `Spoofing.zig` + `ProfileStore` | Validate UA-CH platform/arch, mobile touch, pdfViewer ↔ plugins |
| `scripts/cdp-bot-signals-probe.mjs` | Regression probe (20s budget) |

Touch profiles that list `ontouchstart` in `window_keys` still get data properties via `WindowKeysIntelligent` (on* → null). Desktop profiles do not list them.

**Note:** WPT testdriver builds that need `window.webdriver` must either enable wpt-only snapshot members or inject the helper in the WPT harness. Production antidetect intentionally omits it.

---

## Verification

```bash
cd /Users/huydev/Desktop/velora
make build
node scripts/cdp-bot-signals-probe.mjs --profile chrome-local-huys-macbook-pro --max-sec 20
```

Observed:

- `windowHasWebdriver: false`, `windowWebdriverType: "undefined"`
- `productSub: "20030107"`, `vendorSub: ""`
- `ontouchstartInWindow: false`, `maxTouchPoints: 0`
- `pluginsLength: 5`, mimeTypes prototype-consistent
- `chromeKeys: app, loadTimes, csi`, no `runtime`
- no cdc / selenium markers

---

## Follow-ups

- Optional real `chrome.runtime` with **native-like** non-constructable functions (hard in JS bridge)
- CDP / DevTools session signals (Pro developer_tools) — not fixable by DOM scrub alone
- Profile rarity / VM WebGL strings for Pro `virtual_machine` / `rare_device`
- Re-enable WPT `window.webdriver` via compile flag that includes `wpt_only` members
