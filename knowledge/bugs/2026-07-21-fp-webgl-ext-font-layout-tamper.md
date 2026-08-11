# Fingerprint Pro Tamper Surfaces — WebGL void Extensions, Font Layout, Native Hooks

> **Date:** 2026-07-21 · **Area:** antidetect, Fingerprint Pro smart signals · **Status:** Partially verified (client surfaces fixed; Pro still labels BAS / Tampering Yes)

## Summary

After clearing VM and several bot surface lies, Fingerprint Pro playground still reported **`bot_type: browser_automation_studio`** and **`tampering: true`** with `anti_detect_browser: true`. Deep extraction of the Server API `raw_device_attributes` showed two hard client defects that real Chrome never produces: **almost all WebGL extensions listed as unsupported** (because `getExtension` returned JS `undefined` for void payloads), and **`fonts: []` / flat font metrics** (inline `offsetWidth` was a constant 5px, then stale after `style.fontFamily` mutation).

This pass fixes those surfaces and hardens related automation tells (`window._p`, same-realm native `toString` for OPN/eval hooks). Playground UI still shows BAS + Tampering after the fix — remaining drivers include **iframe clean `Function.prototype.toString`** (cross-realm exposes JS wrapper sources) and Pro **visitor/ML reputation** on sticky `visitor_id`.

---

## Problem

| Signal | Chrome | Koko (before) |
|--------|--------|-----------------|
| `getExtension("OES_texture_float")` | truthy object | `undefined` |
| `unsupported_extensions` | empty / short | ~34 names (nearly all) |
| Font probe `offsetWidth` across families | differs | all `5` then all first-family |
| `fonts` / `font_hash` | rich list | `[]` / MD5 empty |
| `window._p` | absent | present (TrustedTypes stub) |
| `Function.prototype.toString.call(Object.getOwnPropertyNames)` (same realm) | native | JS source |
| Same via **iframe** clean `toString` | native | JS source (still after mask) |

Server API (pre-fix):

```
tampering_details: { anomaly_score: 0.0627, anti_detect_browser: true }
bot_info: { provider: "bablosoft/BAS", name: "BrowserAutomationStudio", confidence: "medium" }
```

`anomaly_score` had already dropped after earlier WebGL1/VERSION work; `anti_detect_browser` stayed true.

---

## Root Cause

### 1. WebGL void extensions → `undefined`

`Extension` union used `void` payloads for extensions without methods. `zigValueToJs(void)` maps to JS **`undefined`**. Fingerprint’s collector treats falsy `getExtension(name)` as unsupported even when `getSupportedExtensions()` lists the name.

### 2. Font detection collapsed

- Inline spans without explicit width used `layout_default_size = 5.0` → every font-family measured identically → zero detections.
- After adding text-width estimation, **mutating `style.fontFamily` on one span** still returned the first measurement: `setProperty` → `syncStyleAttribute` → `setAttribute` → `domChanged` re-aligned `_layout_cache_dom_version` with `version` while the HashMap still held pre-mutation sizes.

### 3. Automation / native lies

- Env TrustedTypes shim injected `globalThis._p` (not a Chrome global).
- CreepJS OPN / Object.keys hooks were plain JS assignments; same-realm `toString` could be masked, but **iframe clean toString** still dumps wrapper source (requires true V8 FunctionTemplate natives).

---

## Solution

| Layer | Change |
|-------|--------|
| `WebGLRenderingContext.zig` | `void` → `EmptyWebGLExtension` struct; empty object is truthy |
| `TextMetrics.zig` | Public `estimateLayoutTextWidth` + resolve first available family from CSS list |
| `Element.zig` | Inline text sizing via `estimateInlineTextSize` when width/height default |
| `Frame.zig` | `invalidateElementLayoutCache()` clears size HashMap |
| `CSSStyleDeclaration.zig` | Invalidate layout cache **after** `syncStyleAttribute` |
| `Env.zig` | Remove `_p`; shared `Function.prototype.toString` mask; non-enumerable `__koko*` helpers |
| `WindowKeysIntelligent` / `NavigatorKeysIntelligent` | `defineProperty` OPN/keys with native name/length |
| `AutomationScrub.zig` | Scrub `_p` / BAS-ish globals |

---

## Verification

```bash
cd /Users/huydev/Desktop/koko
zig build -Doptimize=ReleaseSafe
# WebGL + fonts (reuse one span)
node -e '/* CDP: getExtension truthy; base mono/sans/serif widths differ; Arial detected */'
node scripts/cdp-bot-signals-probe.mjs --profile chrome-local-huys-macbook-pro --max-sec 20
node scripts/cdp-fingerprint-playground-probe.mjs --profile chrome-local-huys-macbook-pro --max-sec 45
```

Observed after fix:

- All sampled `getExtension` names truthy objects
- Reused-span font probe detects Arial, Helvetica Neue, Menlo, …
- Bot surface probe all green
- Playground: VM No, DevTools No, confidence ~0.92; **still** Bot BAS + Tampering Yes

---

## Follow-ups

1. **Native FunctionTemplate wrappers** for `Object.getOwnPropertyNames`, `Object.keys`, and TrustedTypes-aware `eval` so iframe clean `toString` returns `[native code]`.
2. Re-check playground with a **fresh visitor** (sticky `visitor_id` may retain bot reputation).
3. Compare remaining `raw_device_attributes` vs live Chrome (audio hash, webgl extension_parameters digests, canvas).
4. Avoid re-injecting page-global helpers that show up in OPN / `in` probes.
