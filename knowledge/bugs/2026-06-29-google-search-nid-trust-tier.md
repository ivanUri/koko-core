# Google Search trust tier is gated by mature `NID` cookie, not guest cookies

> Part of Phase 6 in [`google-search-investigation-journey.md`](../captcha/detection/google-search-investigation-journey.md). Technical ablation detail for the warmup conclusion.

## Summary

Velora cold-start Google Search without cookies always receives the **long path** (~91KB bootstrap HTML with `sclm=false`, `knitsail`, client `sei` redirect). Injecting **session `NID` from the user's real Chrome profile** flips hop-1 to the **short path** (~266KB direct SERP, no gate vars, no `knitsail`, single document hop). Guest/fresh-Chrome `NID` does **not** flip tier. `DV`, `AEC`, `__Secure-BUCKET`, and `__Secure-STRP` are not sufficient alone.

---

## Problem

Velora and Chrome diverged on Google Search hop-1:

| Engine | Hop-1 body | `sclm` | Hops | Path |
|--------|-----------|--------|------|------|
| Velora (no cookie) | ~91KB | `false` | search → sei | long (knitsail) |
| Chrome curl (user session cookies) | ~271KB | absent | 1 | short (SERP) |
| Velora (user session cookies) | ~266KB | absent | 1 | short (SERP) |

Initial hypothesis: Velora lacks cookies. Partially true, but **cookie quality** matters more than cookie presence.

---

## Root Cause

Google server-side **trust tier selection** on cold `/search` is primarily driven by the **`NID` cookie payload** issued to an established browser profile.

- **Mature `NID`** (exported from user's daily Chrome): server returns full SERP on hop-1.
- **Guest `NID`** (fresh Chrome spawn, first visit): server returns bootstrap gate HTML (`sclm=false`, `ussv=''`, `sp=''`) regardless of other cookies (`AEC`, `__Secure-BUCKET`, `__Secure-STRP`).
- **`DV`** alone does not flip tier; with mature `NID`, `DV` is optional for short path.

Velora wire behavior is correct: `--cookie` loads jar at session init; `omitCookies: in_session` in `browser/policies/google-search.json` withholds cookies only on `sei`/`sg_ss` hops (matches guest Chrome HAR).

Secondary wire gap (does **not** block short path when mature `NID` present):

- Policy `priorOrigin: https://www.google.com` on first hop → Velora sends `Sec-Fetch-Site: same-origin` instead of Chrome omnibox `none`.
- Velora hop-1 omits `Sec-Fetch-User` and `Upgrade-Insecure-Requests` (policy `curlDefaultsOnly: first_hop`).

---

## Investigation

### 1. User curl reproduction

```bash
curl 'https://www.google.com/search?q=velora' \
  -b 'NID=532=SYUsm-...; DV=...; AEC=...; __Secure-BUCKET=CFc; __Secure-STRP=...' \
  # + full Chrome client hint headers
```

Result: `200`, ~271KB, `knitsail=0`, SERP title present.

### 2. Velora A/B (`test-velora-chrome-cookies.mjs`)

| Case | Hop-1 body | `sclm` | Hops |
|------|-----------|--------|------|
| No cookie | 91KB | `false` | 2 (→ sei) |
| User 5 cookies | 266KB | null | 1 |

### 3. Cookie ablation (`probe-cookie-ablation.mjs`)

**Base: `chrome-real-cookies.json` (user session)**

| Case | Tier | Body | Notes |
|------|------|------|-------|
| none | long-bootstrap+sei | 91KB | baseline |
| all-5 | short-direct | 266KB | |
| **NID-only** | **short-direct** | 267KB | **sufficient** |
| DV-only | long-bootstrap+sei | 91KB | insufficient |
| NID+DV | short-direct | 266KB | |
| all-minus-NID | long-bootstrap+sei | 91KB | NID required |
| all-minus-DV | short-direct | 329KB | DV optional |
| all-minus-AEC/BUCKET/STRP | short-direct | 266KB | optional |

**Base: `chrome-cookies.json` (fresh Chrome guest)**

| Case | Tier | Body |
|------|------|------|
| all-4 / NID-only / any subset | long-bootstrap+sei | ~91KB |

Guest `NID` (231 chars) vs mature `NID` (280 chars) — similar size, **different encoded trust state**.

### 4. Long vs short hop-1 HTML signatures

| Signal | Long path | Short path |
|--------|-----------|------------|
| Body size | ~91KB | ~266–331KB |
| `sclm` | `false` or `true` | absent |
| `ussv` / `sp` | `''` | absent |
| `knitsail` refs | 3+ | 0 |
| `knitsail.a` | 0 in hop-1 HTML | 0 |
| Document hops | 2 (search → sei) | 1 |
| Script count (curl) | — | ~17 |

---

## Solution

### Immediate (ops)

1. Export cookies from **real Chrome profile** before Velora search:
   ```bash
   node google-search-debug/scripts/export-chrome-cookies.mjs --chrome-attach
   ```
2. Start Velora with session restore:
   ```bash
   zig-out/bin/velora serve --browser-profile <id> \
     --cookie google-search-debug/tmp/chrome-real-cookies.json \
     --cookie-jar google-search-debug/tmp/session-cookies.json
   ```
3. Re-export when `NID`/`__Secure-STRP` expire.

### Product (future)

- Auto-sync cookie jar from attached Chrome CDP at session start.
- Persist `--cookie-jar` across runs so `NID` survives restarts.
- Do **not** fake `ussv`/`sp`/`sclm` client-side — tier is server-side; mature `NID` is the legitimate signal.

### Wire parity (lower priority while NID present)

- First-hop `Sec-Fetch-Site: none` — policy `priorOrigin` currently forces `same-origin`.
- First-hop `Sec-Fetch-User: ?1` — blocked by `curlDefaultsOnly: first_hop` + guest HAR policy.

---

## Verification

```bash
# Ablation (11 cases, ~3 min)
node google-search-debug/scripts/probe-cookie-ablation.mjs \
  --base google-search-debug/tmp/chrome-real-cookies.json

# A/B no-cookie vs session cookies
node google-search-debug/scripts/test-velora-chrome-cookies.mjs \
  --no-export --cookie-file google-search-debug/tmp/chrome-real-cookies.json
```

Artifacts:

- `google-search-debug/tmp/cookie-ablation-1782714904971/report.json`
- `google-search-debug/tmp/cookie-ab-1782714477236/report.json`
- `google-search-debug/tmp/chrome-real-cookies.json`

---

## Related

- `browser/policies/google-search.json` — `omitCookies: in_session`
- `src/runtime/cookies.zig` — `--cookie` load format
- `google-search-debug/scripts/export-chrome-cookies.mjs`
- `google-search-debug/scripts/probe-cookie-ablation.mjs`
- `knowledge/bugs/2026-06-29-google-search-bootstrap-divergence.md`