# FingerprintJS OSS Parity + Native Builtin Hooks (Pro Playground)

> **Date:** 2026-07-21 · **Area:** antidetect, FingerprintJS OSS sources, Fingerprint Pro · **Status:** Client parity verified; Pro still BAS/Tamper (visitor sticky)

## Summary

Using public FingerprintJS (`fingerprintjs-master`) as a **device-attribute spec**, Velora now passes a CDP parity probe aligned with OSS `fonts`, `fontPreferences`, `webGlBasics`/`webGlExtensions`, OfflineAudio **44100**, and architecture **127**. Critical automation tell **iframe clean `Function.prototype.toString`** on `eval` / `Object.getOwnPropertyNames` / `Object.keys` now returns `[native code]` via V8 FunctionTemplate natives (`NativeBuiltinHooks.zig`).

Fingerprint Pro playground still reports **bot BAS + Tampering Yes** (same sticky `visitor_id`); one run also showed **VM Yes / suspect 29** (regression vs earlier VM No / 15 — treat as ML + visitor reputation noise until retested with a fresh visitor).

---

## What was implemented

| Area | Change |
|------|--------|
| `NativeBuiltinHooks.zig` | FunctionTemplate natives for **eval** (TrustedScript unwrap), **getOwnPropertyNames** (window key order), **Object.keys** (navigator order). HashMap OPN reorder (avoid O(n²) hang). |
| `Env.zig` | JS eval/`_p` shim replaced by native eval install |
| `WindowKeysIntelligent` / `NavigatorKeysIntelligent` | Drop JS OPN/keys hooks → call native install |
| `WebGLRenderingContext` | Empty extensions truthy; **OES_standard_derivatives**, **OES_vertex_array_object**, draw_buffers color attachment constants; `getParameter` for FPJS `validExtensionParams` |
| `Element` / `TextMetrics` | Inline text width; `font` shorthand + system font families for fontPreferences |
| `scripts/cdp-fpjs-parity-probe.mjs` | Regression probe (20s budget) |

---

## Verification

```bash
cd /Users/huydev/Desktop/velora
zig build -Doptimize=ReleaseSafe
node scripts/cdp-fpjs-parity-probe.mjs --profile chrome-local-huys-macbook-pro --max-sec 20
node scripts/cdp-fingerprint-playground-probe.mjs --profile chrome-local-huys-macbook-pro --max-sec 45
```

### FPJS parity probe (all OK)

- fonts: 16 detected (Helvetica Neue, Menlo, Arial, …); base mono/sans/serif widths differ  
- fontPreferences: default/apple/serif/sans/mono/min/system **not** flat 5  
- `unsupportedExtensions: []`, WebGL 1.0 VERSION  
- OfflineAudio `sampleRate: 44100`  
- architecture `127`  
- iframe clean toString: **opn/keys/eval all native**

### Playground (still open)

```
bot: browser_automation_studio
tampering: Yes
vm: Yes (regressed vs prior No in same session)
suspect: 29
confidence: 0.92–1.0
```

### Fresh visitor experiment (`chrome-probe-fresh-20260721`)

Nudged screen 1920×1080, hwConcurrency 10, deviceMemory 8:

| Field | Main profile | Fresh profile |
|-------|--------------|---------------|
| visitor_id | `8dk0BIDa7WiA7BFfLGRx` | **`qc0I81k1szMwHLMLpKnV`** (new) |
| confidence | 0.92 | **1** |
| bot | BAS | **BAS** (unchanged) |
| tampering | Yes | **Yes** |
| vm | Yes | **Yes** |
| suspect | 29 | **29** |

**Conclusion:** BAS/Tamper/VM are **attribute-class**, not only sticky visitor reputation. Fresh visitor_id did not clear bot flags.

Catalog path: `browser/catalog/chrome-probe-fresh-20260721/` (local probe only; do not ship).

### WebGL extension-param revert (confirm +14 = VM)

Reverted invented OES_*/DRAW_BUFFER `getParameter` values (kept empty extension truthy + native OPN cache).

| After revert | Value |
|--------------|--------|
| VM | **No** |
| suspect | **15** |
| bot / tamper | BAS / Yes (unchanged) |

Confirms suspect **15→29** was **VM re-trigger**, not bot/tamper weight change.

---

## Notes

- FingerprintJS OSS has **no** Bot/Tamper smart signals — useful only as attribute implementation reference.
- Pro BAS / `anti_detect_browser` remain proprietary ML on device + network signals.
- OPN native reorder on ≥900 keys must stay O(n); quadratic scan hung Runtime.evaluate on playground.

## Follow-ups

1. Diff Chrome live `extensionParameters` / audio / canvas vs Velora under same profile.  
2. Investigate VM Yes regression (WebGL extension constants / ML features).  
3. Pro agent-only signals (workers, behavioral) beyond OSS FingerprintJS.
