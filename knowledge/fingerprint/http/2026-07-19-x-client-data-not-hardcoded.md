# X-Client-Data must not be a stale Zig hardcode

> **Audience:** Velora engineers working on Google Search cold path and HTTP identity.  
> **Date:** 2026-07-19

## Summary

Velora was emitting a hard-coded `X-Client-Data: CLaAywE=` from `XBrowser.zig`. That value was a *past* Chrome ExtraInfo capture, not a stable property of Chrome 150. A same-day A/B on this host showed live Chrome/150.0.7871.129 headed guest hop-1 sending **`CMjzygE=`** while Velora still sent `CLaAywE=`.

Hardcoding a field-trial seed in Zig is wrong: the seed **rotates**. Source of truth is now `browser/policies/plugins/x-browser.json` → `clientData`, with env override `VELORA_X_CLIENT_DATA` for A/B. After the fix, Velora hop-1 XCD matches live Chrome (`CMjzygE=`). Cold Velora still reaches `/sorry` — XCD parity alone does not unlock SERP (consistent with prior pure-cold A/Bs).

---

## Problem

Chrome guest cold search on the same machine SERPs with hop-1 **Cookie=0**. Velora cold with empty jar hits `/sorry`. Hop-1 header ExtraInfo comparison showed near-full parity except `X-Client-Data`:

| Lane | X-Client-Data | Outcome |
|------|---------------|---------|
| Chrome headed fresh | `CMjzygE=` | SERP |
| Velora cold (before) | `CLaAywE=` (Zig string) | sorry |
| Velora cold (after) | `CMjzygE=` (from JSON) | still sorry |

Tempting assumption: “use any short XCD Chrome once used.” That freezes a **variations assignment** that Google re-seeds independently of UA major.

---

## Root Cause

`X-Client-Data` is Chrome **Client Variations** (base64 protobuf of field-trial IDs), not a static “Chrome 150 token.”

Evidence of rotation on the same binary:

| When | Chrome build | Hop-1 XCD |
|------|--------------|-----------|
| 2026-07-17 ExtraInfo ref | 150.0.7871.129 | `CLaAywE=` (varint `0x32c036`) |
| 2026-07-19 guest A/B | 150.0.7871.129 | `CMjzygE=` (varint `0x32b9c8`) |

The Zig default was the July-17 capture. By July-19 it was already wrong on the same machine.

Architecture mistake: treating a **session/seed capture** like `X-Browser-Year` (stable product string). Validation digest can be pinned per major; variations IDs cannot.

---

## Fix

1. **`browser/policies/plugins/x-browser.json`**
   - `clientData`: live capture `CMjzygE=`
   - `clientDataSource`: provenance string for re-capture

2. **`XBrowser.zig`**
   - Load `clientData` into `Config.client_data` (required; empty → `MissingClientData`)
   - `appendHeaders`: env `VELORA_X_CLIENT_DATA` **or** config (no Zig b64 default)
   - Unit test asserts loaded value matches JSON capture

3. **Refresh** `code-check/tmp/chrome-hop1-extrainfo-ref.json` to the July-19 seed.

Wire check after rebuild:

```
hop1Xcd: "CMjzygE="   // matches Chrome headed cold2
sei still h2 → /sorry 429  // residual elsewhere (TLS/QUIC, sei protocol stickiness)
```

---

## Verify

```bash
# Wire XCD after change
# serve + CDP Network.requestWillBeSent on google.com/search empty jar
# expect hop-1 X-Client-Data == chrome-guest-vs-velora-cold2 hop1 (CMjzygE=)

# Re-capture when Chrome major or seed drifts:
# 1) headed Chrome empty user-data-dir → google.com/search
# 2) CDP requestWillBeSentExtraInfo → x-client-data
# 3) paste into x-browser.json clientData + clientDataSource
```

Artifacts:

- A/B: `code-check/tmp/chrome-guest-vs-velora-cold2/`
- Post-fix probe: `code-check/tmp/xcd-sync-check/result.json`

---

## Follow-ups (not fixed here)

- **sei hop stays h3 on Chrome, falls to h2 on Velora** — stronger residual than XCD value.
- TLS/QUIC fingerprint under HTTP (prior knitsail notes still apply).
- Optional: auto-refresh `clientData` from a capture script into the JSON policy (still data, not Zig).

---

## Related

- `knowledge/captcha/detection/2026-07-17-pure-cold-n-rate-and-residuals.md` — fat vs short XCD ruled out as sole unlock
- `code-check/google-search-ab/ANALYSIS-cold-chrome-vs-velora.md`
- `src/runtime/profile/plugins/XBrowser.zig`
- `browser/policies/plugins/x-browser.json`
