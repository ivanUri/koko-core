# Google Search Trust Tier Is Gated by Mature `NID` Cookie, Not Guest Cookies

> **Phase 6** in the canonical investigation: [`google-search-investigation-journey.md`](../captcha/detection/google-search-investigation-journey.md). This note is the technical ablation detail behind the warmup conclusion — *cookie quality beats cookie count*.

## Summary

Velora cold-start Google Search without cookies always receives the **long path**: ~91 KB bootstrap HTML with `sclm=false`, inline `knitsail`, and a client-side redirect to `sei` or `sg_ss`. Injecting a **session `NID` cookie exported from the user's real Chrome profile** flips hop-1 to the **short path**: ~266–331 KB direct SERP HTML, no gate variables, no `knitsail` references, and a single document hop. Guest or fresh-Chrome `NID` does **not** flip the tier. `DV`, `AEC`, `__Secure-BUCKET`, and `__Secure-STRP` are helpful session hygiene but are **not sufficient alone** without a mature `NID`. The unlock is server-side trust tier selection driven by cookie payload semantics, not client-side fingerprint parity or wire-header cosmetics.

---

## Problem

After weeks of CreepJS parity work, TLS/JA4 alignment, knitsail survival fixes, and `pageT` tuning, Velora and Chrome still diverged sharply on the **same machine, same IP, same query** when Velora started with an empty cookie jar:

| Engine | Hop-1 body | `sclm` | Document hops | Path |
|--------|-----------|--------|---------------|------|
| Velora (no cookies) | ~91 KB | `false` | search → sei | long (knitsail) |
| Chrome curl (user session cookies) | ~271 KB | absent | 1 | short (SERP) |
| Velora (user session cookies) | ~266 KB | absent | 1 | short (SERP) |

The symptom looked like a client detection failure. Velora's antidetect profile could pass many CreepJS sections while still receiving bootstrap gate HTML. Chrome on the same network, with a warmed profile, got a full results page on the first navigation.

Initial hypothesis: *Velora lacks cookies; export Chrome's jar and parity will follow.* That was partially true — but **which cookies** and **what trust state they encode** mattered far more than simply having *any* `NID` present. A guest Chrome spawn that had visited Google once still produced long-path HTML even with four freshly issued cookies. Only the mature `NID` from a daily-driver Chrome profile flipped the tier.

From a browser architecture standpoint, this is not a rendering bug. Google Search hop-1 is a **server-chosen document type** delivered over HTTP before any significant client JavaScript runs. The HTML shape — bootstrap shell versus full SERP — is decided by Google's edge using session signals embedded in the cookie jar. Velora's HTTP stack (curl-impersonate, policy-driven headers, cookie injection at session init) was behaving correctly; the missing ingredient was **trust-encoded session state** that Google's backend recognizes as an established browser profile.

---

## Root Cause

Google applies **server-side trust tier selection** on cold `GET /search` requests. The primary gate is the **`NID` cookie payload** — a large, periodically rotated value that encodes profile maturity, visit history, and risk scoring state. This is opaque to the client; you cannot infer tier from cookie name alone or from byte length alone (guest `NID` ≈ 231 chars, mature `NID` ≈ 280 chars — similar size, different encoded trust).

### Tier behavior observed

| Cookie state | Hop-1 outcome |
|--------------|---------------|
| **Mature `NID`** (exported from user's daily Chrome) | Full SERP on hop-1 (~266–331 KB) |
| **Guest `NID`** (fresh Chrome, first visit) | Bootstrap gate HTML (`sclm=false`, `ussv=''`, `sp=''`) regardless of `AEC`, `__Secure-BUCKET`, `__Secure-STRP` |
| **No cookies** | Same as guest — long bootstrap path |
| **`DV` alone** | Does not flip tier; with mature `NID`, `DV` is optional for short path |

Ablation proved **`NID`-only** is sufficient for short path when sourced from a real profile. Removing `NID` from an otherwise complete five-cookie jar restored long path. Removing `DV`, `AEC`, `BUCKET`, or `STRP` while keeping mature `NID` left short path intact.

### Velora wire behavior (correct, secondary gaps noted)

Velora loads cookies via `--cookie` at session initialization (`src/runtime/cookies.zig`). Policy `omitCookies: in_session` in `browser/policies/google-search.json` withholds cookies only on `sei`/`sg_ss` in-session hops — matching guest Chrome HAR captures. This is **not** why cold Velora fails; cold Velora fails because hop-1 never receives a mature `NID` in the first place.

Secondary wire gaps (`Sec-Fetch-Site`, `Sec-Fetch-User`) do not block short path when mature `NID` is present — hygiene only.

Hop-1 tier is chosen **before** inline bootstrap runs (see [`google-search-flow-architecture.md`](../captcha/detection/google-search-flow-architecture.md)). Client `knitsail`/`pageT` work cannot upgrade server-assigned bootstrap HTML without the right session cookies.

---

## Investigation

After wire and knitsail fixes plateaued (journey Phase 5–6), we ran controlled cookie ablation.

### 1. User curl reproduction

```bash
curl 'https://www.google.com/search?q=velora' \
  -b 'NID=532=SYUsm-...; DV=...; AEC=...; __Secure-BUCKET=CFc; __Secure-STRP=...'
```

Result: `200`, ~271 KB, `knitsail=0`, SERP title — short path without Velora JS.

### 2. Velora A/B (`test-velora-chrome-cookies.mjs`)

| Case | Hop-1 body | `sclm` | Hops |
|------|-----------|--------|------|
| No cookie | 91 KB | `false` | 2 (→ sei) |
| User 5 cookies | 266 KB | null | 1 |

Same Velora binary, same profile, same query — only cookie jar differed. Definitive proof that session state gates tier.

### 3. Cookie ablation (`probe-cookie-ablation.mjs`)

**Base: `chrome-real-cookies.json` (user session)**

| Case | Tier | Body | Notes |
|------|------|------|-------|
| none | long-bootstrap+sei | 91 KB | baseline |
| all-5 | short-direct | 266 KB | |
| **NID-only** | **short-direct** | 267 KB | **sufficient** |
| DV-only | long-bootstrap+sei | 91 KB | insufficient |
| NID+DV | short-direct | 266 KB | |
| all-minus-NID | long-bootstrap+sei | 91 KB | NID required |
| all-minus-DV | short-direct | 329 KB | DV optional |
| all-minus-AEC/BUCKET/STRP | short-direct | 266 KB | optional |

**Base: `chrome-cookies.json` (fresh Chrome guest)**

| Case | Tier | Body |
|------|------|------|
| all-4 / NID-only / any subset | long-bootstrap+sei | ~91 KB |

Guest `NID` never flips tier regardless of combination. Encoded trust state differs from mature profile export.

### 4. Long vs short hop-1 HTML signatures

| Signal | Long path | Short path |
|--------|-----------|------------|
| Body size | ~91 KB | ~266–331 KB |
| `sclm` | `false` or `true` | absent |
| `ussv` / `sp` | `''` | absent |
| `knitsail` refs | 3+ | 0 |
| `knitsail.a` in hop-1 HTML | 0 | 0 |
| Document hops | 2 (search → sei) | 1 |
| Script count (curl) | — | ~17 |

These signatures became the fast diagnostic: `wc -c` on hop-1 response body tells you tier before parsing JavaScript.

### 5. What we ruled out

TLS/JA4 mismatch alone, CreepJS green sections, and client-side faking of `ussv`/`sp`/`sclm` — tier is server-decided.

---

## Solution

### Immediate (operations)

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

3. Re-export when `NID` / `__Secure-STRP` expire (typically days to weeks depending on account activity).

4. Persist `--cookie-jar` across runs so rotated cookies survive restarts.

### Product (future)

- Auto-sync cookie jar from attached Chrome CDP at session start.
- Surface tier diagnostic in debug UI: hop-1 body size + `sclm` presence.
- Do **not** attempt to synthesize mature `NID` — it is server-issued and cryptographically bound to profile history.

### Wire parity (lower priority when NID present)

- First-hop `Sec-Fetch-Site: none` — revisit policy `priorOrigin` forcing `same-origin`.
- First-hop `Sec-Fetch-User: ?1` — currently blocked by `curlDefaultsOnly: first_hop` + guest HAR policy.

---

## Lessons Learned

1. **Measure hop-1 body size before debugging knitsail** — ~91 KB means cold tier.
2. **Cookie presence ≠ cookie trust** — ablate guest vs mature `NID`.
3. **CreepJS green is layer 4; session cookies are layer 0** (journey doc).
4. **Do not fake `sclm`/`ussv`/`sp`** — warm the jar instead.
5. **`NID` is necessary; `DV` is optional** on the tested profile.
6. **Run `probe-cookie-ablation.mjs` when tier regresses** — jar expiry vs engine regression.

---

## Verification

```bash
cd /Users/huydev/Desktop/velora

# Ablation (11 cases, ~3 min)
node google-search-debug/scripts/probe-cookie-ablation.mjs \
  --base google-search-debug/tmp/chrome-real-cookies.json

# A/B no-cookie vs session cookies
node google-search-debug/scripts/test-velora-chrome-cookies.mjs \
  --no-export --cookie-file google-search-debug/tmp/chrome-real-cookies.json

# Quick tier sniff on live navigation
node google-search-debug/scripts/run-google-search-with-session.mjs --query "velora"
```

**Pass criteria:**

- `NID-only` ablation case → `short-direct`, body > 250 KB, `sclm` absent.
- `all-minus-NID` → `long-bootstrap+sei`, body ~91 KB.
- Guest jar base → all cases long path regardless of subset.

**Artifacts:**

- `google-search-debug/tmp/cookie-ablation-*/report.json`
- `google-search-debug/tmp/cookie-ab-*/report.json`
- `google-search-debug/tmp/chrome-real-cookies.json`

---

## References

- [`google-search-investigation-journey.md`](../captcha/detection/google-search-investigation-journey.md) — Phase 6 warmup conclusion
- [`google-search-flow-architecture.md`](../captcha/detection/google-search-flow-architecture.md) — multi-hop state machine
- [`google-search-signal-inventory.md`](../captcha/detection/google-search-signal-inventory.md) — signal catalog
- `browser/policies/google-search.json` — `omitCookies: in_session`, first-hop policy
- `src/runtime/cookies.zig` — `--cookie` load format
- `google-search-debug/scripts/export-chrome-cookies.mjs`
- `google-search-debug/scripts/probe-cookie-ablation.mjs`
- `google-search-debug/scripts/test-velora-chrome-cookies.mjs`

---

## Related Knowledge

- [Google Search bootstrap divergence](./2026-06-29-google-search-bootstrap-divergence.md) — long-path symptom catalog (superseded as root-cause narrative)
- [Google Search knitsail window-keys prune](./2026-06-29-google-search-knitsail-window-keys-prune.md) — client-side long-path prerequisite
- [CreepJS navigator parity](../fingerprint/navigator/creepjs-navigator-parity.md) — fingerprint layer (secondary to session tier)
- [CreepJS TLS JA3/JA4 parity](../fingerprint/tls/creepjs-tls-ja3-ja4-parity.md) — wire hygiene (necessary, not sufficient)