# SerpBase Knitsail / SG_SS: what it actually measures (and what Velora still lacks)

> **Audience:** Velora engineers working on Google Search cold path and knitsail bootstrap.  
> **Source:** [SerpBase — Google Knitsail and SG_SS](https://serpbase.dev/blog/google-knitsail-and-sg-ss-generation-logic-and-its-role-in-distinguishing-automa) (2026-04-15), cross-checked with Velora live A/B (2026-07-16…17).

## Summary

`SG_SS` is **not** a hash, HMAC, or signature of “who the user is.” It is a **base64url-framed binary telemetry packet** produced by Google’s **Knitsail VM**: decrypt bytecode from parameter `p`, run a custom VM against the live browser environment, pack channels + random header/padding, emit `*…`.

The VM’s job is **environment authenticity** — “does this look like a real browser executing naturally inside a real page?” — not human identification. That score feeds anti-automation. For Velora, this means:

1. **Client knitsail fixes** (pageT freeze, DCL during parse, trustedTypes, timing texture) only shape the **failure / bootstrap** path.
2. **Cold SERP unlock** still lives on **hop-1** (TLS/QUIC, brands, cookies). Improving SG_SS quality does not turn empty-jar knitsail HTML into SERP by itself.
3. Cookies from a real Chrome session (even guest `velora57`) remain the practical Layer-0 bypass.

---

## What the article teaches

### Pipeline

```
p (program material) → decrypt bytecode (Xj keystream) → run VM(env)
  → write channels (some XOR-obfuscated) → finalize + randomBytes → * + base64url
```

- `p` is **VM program material**, not user payload to sign.
- Final string mixes **env-derived data**, structure/length bytes, and **random** header/padding — so bit-identical SG_SS across runs is not expected even on the same machine.

### Signals the VM reads (consistently observed)

| Class | Examples |
|-------|----------|
| Timing | `performance.now()`, `performance.timing` |
| Lifecycle | `document.readyState` |
| Platform | `window.trustedTypes` |
| Profile (differential) | `navigator.*`, `screen.*`, `location.href` |

### What “looks automated” means here

Not “prove human.” More like a score over:

- **Timing texture** of VM execution (jitter, not flat synthetic clocks)
- **Lifecycle** at encode time (`interactive` / `complete`, not stuck `loading`)
- **Capability surface** (`trustedTypes` present when claimed Chrome)
- **Cross-field consistency** (UA vs screen vs hardware vs locale)

Patched Node “fake window” fails because browser is a **coherent runtime**, not a bag of properties.

### Privacy angle

Environment/device fingerprinting and session linkability — not name/email disclosure.

---

## What Velora already implements (aligned with SerpBase)

| SerpBase requirement | Velora status |
|----------------------|---------------|
| DCL / `readyState` before encode (~200ms window) | `Frame.tryPumpKnitsailDocumentLifecycle` during parse (not post full HTML drain) — see `knowledge/bugs/2026-07-15-google-knitsail-dcl-during-parse.md` |
| `chrome.csi().pageT` ~185–195ms | Freeze `192.59999999403954` for `frozenNowMs()` / CSI |
| Timer probes t20/t80/t200 | `pumpKnitsailTimerMilestones` |
| Hold `sg_ss` microtasks until post-parse | `_defer_knitsail_post_parse` |
| `window.trustedTypes` | Implemented + eval shim |
| `performance.timing` navigation stamps | Fast-nav Chroma-like offsets in `recordResponseStart` |
| Scope to `/search` only | `isGoogleKnitsailHost` requires `/search` |

---

## Gaps and 2026-07-17 follow-up

### 1. Flat freeze on `performance.now()` (fixed)

SerpBase §V.1: multi-sample **timing texture**. After DCL pump, Velora set `_frozen_now_ms` and returned the **same float** on every `now()` call. That is correct for *magnitude* (avoid 5–15s wall clock) but **wrong for texture** (too flat).

**Fix:** `Performance.now()` while frozen adds 0–82μs jitter from the high-res clock; `frozenNowMs()` / `chrome.csi().pageT` stay exact. Integer-now mode (Accounts) unchanged.

### 2. Cold hop-1 still dominates SERP vs knitsail

Live results (same IP):

| Jar | Hop-1 trust | Result |
|-----|-------------|--------|
| Empty / native Velora warm (NID only) | Low | knitsail or `/sorry` |
| Chrome Profile 57 guest (NID+AEC+YT…) | Medium | **SERP** |
| Chrome Profile 45 mature (SID…) | High | **SERP** |

So even a perfect SG_SS encode only helps **after** Google already chose the bootstrap HTML. Cold Chrome SERPs with Cookie=0 because of **wire stack**, not because Chrome “fakes SG_SS better” alone.

### 3. Product paths verified 2026-07-17 (later same day)

| Path | How | Cold empty jar | Result |
|------|-----|----------------|--------|
| Pure Velora curl hop-1 | default serve | yes | knitsail / `/sorry` |
| **Chrome cookie jar** | `scripts/chrome-profile-cookie-search.mjs --chrome-profile 57` | no (9 guest cookies) | **SERP OK** (~670KB) |
| **Chrome sidecar hop-1** | `--google-chrome-transport` + policy `first_hop_or_query_contains` | yes | **SERP OK** (~380KB, with `sei=`) |

Policy change: `browser/policies/google-search.json` `externalTransport.when` = `first_hop_or_query_contains` (was `query_contains` / `sg_ss=` only). Flag still opt-in via `--google-chrome-transport`.

Still open for pure-curl cold SERP:

- QUIC JA4 residual gaps vs Chrome 150
- ECH multi-safe
- Not sufficient alone historically: h3 + X-Client-Data + chrome150 brands already tried

---

## Practical takeaway for “fix next”

```mermaid
flowchart TD
  hop1[Hop-1 document request] --> tier{Server HTML tier}
  tier -->|SERP ~300KB+| done[rso results]
  tier -->|bootstrap ~90KB knitsail| vm[Knitsail VM + SG_SS]
  vm --> hop2[sei/sg_ss hop]
  hop2 --> tier2{Server again}
  tier2 -->|still low trust| sorry[/sorry or knitsail loop]
  tier2 -->|cookies/trust| done
```

- **If goal is SERP without Chrome cookies:** invest in hop-1 (h3, brands, TLS), not only knitsail.
- **If goal is correct demotion path / sg_ss quality:** lifecycle + timing texture + profile consistency (this note’s fix).
- **If goal is product reliability today:** inject Chrome-issued cookies (guest or account) or Chrome transport.

---

## Verification

```bash
# Build
cd /Users/huydev/Desktop/velora && zig build

# Cold empty jar should still show knitsail OR sorry (hop-1), but:
# - pageT ≈ 192.6, readyState interactive, trustedTypes true
# - repeated performance.now() during freeze are not all bit-equal
```
