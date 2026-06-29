# Google Search Signal Inventory (SGS Bootstrap)

> **⚠️ Priority revised (2026-06-29).**  
> Read first: [`google-search-investigation-journey.md`](google-search-investigation-journey.md)  
> **Layer 0 (session cookies) is the primary production gate.** Layers 2–5 below dominate only on the **long path** (~91 KB bootstrap). Warm jar → Layer 1 often skips straight to SERP.

## Summary

Google Search is a **trust-tier state machine**. With a **mature Chrome cookie jar**, hop 1 is often a **full SERP** (~270–600 KB, no `knitsail`). With a **cold session**, Google returns an **SGS bootstrap shell** (~91 KB): inline scripts, `knitsail`, `sg_ss` encode, multi-hop navigation, `/sorry` risk. Velora must warm the jar operationally; fingerprint and wire parity are secondary.

---

## Signal layers (re-prioritized)

### Layer 0 — Session cookies (**PRIMARY**)

| Signal | Source | Velora handling | Notes |
|--------|--------|-----------------|-------|
| `NID` payload | Chrome profile history | `--cookie-jar` load on start | **Mature `NID` alone flips short path** (ablation) |
| `SID` / `SAPISID` / `HSID` family | Signed-in Chrome | Live export (`browser-cookie3`) | ~154 cookies typical |
| Guest `NID` | Fresh Chrome spawn | Insufficient | Same name, different trust encoding |
| `DV` | Per-visit `www.google.com` | Optional with mature `NID` | Not required for tier flip |
| Cookie on in-session hops | HAR | `omitCookies: in_session` | Correct; cookies matter on **hop 1** |

**Production:**

```bash
node google-search-debug/scripts/export-chrome-live-cookies.mjs
zig-out/bin/velora serve --cookie-jar browser/profiles/assets/chrome-local-huys-macbook-pro-google-cookies.json
```

Jar path persists load+save since 2026-06-29 (`CDP.zig`, `MCP Server.zig`).

---

### Layer 1 — Server-side (pre-HTML)

| Signal | Notes |
|--------|-------|
| Client IP / rate limit | Hot IP → `/sorry` for both engines; probe sequentially |
| TLS fingerprint | curl-impersonate chrome149 — necessary hygiene |
| Trust tier decision | **Driven by cookie state** → bootstrap vs SERP HTML |

---

### Layer 2 — HTTP headers (hygiene)

Document navigations: `HttpProfile.zig`, `google-search` policy.

- Cold hop: full Chrome client hints, `curlDefaultsOnly` omits some curl defaults.
- In-session `sei`/`sg_ss`: omit cookies, omit Sec-Fetch-*, Downlink/RTT 1.7/100.

**Does not flip tier** when jar is cold; minor when jar is warm.

---

### Layer 3 — Inline bootstrap (LONG PATH ONLY)

When hop-1 ≈ **91 KB** and `sclm=false`:

| Script | Role |
|--------|------|
| 2 | Knitsail loader (~62 KB) |
| 3 | SGS bootstrap — `la()` → `knitsail.a()` |
| 4 | `sg_trbl` beacon |

Short path SERP: **no gate vars**, `knitsail=0`.

---

### Layer 4 — SGS timing (`pageT`, `td`, `google.tick`)

Relevant **only on long path**. Fixes in `Frame.zig`, `GoogleCompat.zig`.

---

### Layer 5 — Post-fail `/sorry` + reCAPTCHA

Sorry parity probes; `HTMLElement.style` shim for cfgClients. Forensics, not warmup.

---

## Thermometer: hop-1 body size

| Hop-1 size | Meaning | Action |
|------------|---------|--------|
| ~91 KB | Cold / low trust | Export live jar, re-search |
| ~270–600 KB | Warm / SERP | OK — parse results |
| URL contains `sg_ss` | Long-path encode | Refresh jar, cool IP |

---

## What we thought → tested → learned

1. **Thought:** CreepJS fingerprint is the Search blocker → **Test:** section compares → **Learn:** unrelated to hop-1 tier.
2. **Thought:** Wire headers flip tier → **Test:** diff-sei, wire capture → **Learn:** hygiene only.
3. **Thought:** knitsail/`pageT` is root cause → **Test:** bootstrap probes → **Learn:** long-path symptoms.
4. **Thought:** Any cookies help → **Test:** guest 4-cookie A/B → **Learn:** guest `NID` useless.
5. **Thought:** Need real account session → **Test:** live export + ablation → **Learn:** **warmup jar is the essence.**

---

## References

- `google-search-investigation-journey.md` — full narrative
- `bugs/2026-06-29-google-search-nid-trust-tier.md` — ablation data
- `google-search-debug/scripts/probe-cookie-ablation.mjs`