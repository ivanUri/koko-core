# Google Search Bootstrap Divergence: Velora sg_ss Path vs Chrome sei Short Path

> **⚠️ Superseded as root-cause narrative (2026-06-29).**  
> Read first: [`google-search-investigation-journey.md`](../captcha/detection/google-search-investigation-journey.md)  
> **Primary fix:** warmup mature Chrome cookie jar (`NID` + session cookies). Cold Velora → long bootstrap path documented below. Warm Velora → short SERP hop-1; knitsail sections often **do not apply**.

## Summary (revised)

Velora **without a warmed cookie jar** takes the **knitsail / sg_ss long path** (~91 KB bootstrap, client `sei`/`sg_ss` redirects). Chrome with a **trusted session** often takes the **short path** (full SERP on hop 1, 0× `knitsail.a`). TLS and wire-header fixes are hygiene; **session cookie state** is the main tier flip. This file remains a **long-path symptom catalog** and wire-diff log — not the production unlock story.

---

## Problem

After fixing TLS (JA4/JA3n/Akamai/QUIC) and `knitsail` window-keys prune, Velora **still** hit long path and `/sorry` when the cookie jar was empty. Chrome with mature cookies on the same machine got SERP on hop 1.

| Checkpoint | Chrome (warm session) | Velora (cold jar) |
|------------|----------------------|-------------------|
| Hop-1 body | ~270–600 KB SERP | ~91 KB bootstrap |
| `knitsail.a()` | **0** | **1–4×** |
| Document hops | 1 (or fast sei SERP) | 2+ (bootstrap → sei/sg_ss) |
| `sclm` in HTML | absent | `false` + empty `ussv`/`sp` |

---

## Root Cause (revised)

### Primary — cold session (no mature cookie jar)

Google selects trust tier **before** inline bootstrap runs. Mature `NID` (+ signed-in cookies) → SERP HTML. Guest/cold → bootstrap shell with `sclm=false`, empty `ussv`/`sp` → `la()` → knitsail.

See: `bugs/2026-06-29-google-search-nid-trust-tier.md`, cookie ablation `probe-cookie-ablation.mjs`.

### Secondary — long-path client behavior (only when tier is already low)

When already on bootstrap HTML, these mattered:

1. Hop-1 `sclm=false` → `window.td` not set → `ha()` empty.
2. `pageT` at `knitsail.a()` ~303 ms vs ~192 ms target.
3. `knitsail` pruned from `window` before async bootstrap.
4. Wire gaps on in-session `sei` hops (Downlink/RTT, Sec-Fetch).

---

## Long-path mechanics (reference)

### Hop-1 gate (low trust)

```javascript
window.sgs && ussv && sp
  ? window.sgs(sp).then(ok => { /* short path */ })
  : Promise.resolve(false);
Z.then(a => a || la());  // la() → knitsail → sg_ss
```

Captured cold Velora: `ussv=''`, `sp=''` → always `la()`.

### `pageT` / `google.tick` / `td` (long-path fixes)

- `pageT` freeze must cover async knitsail chain.
- `google.tick()` implemented; inject script seeds `td.qs`/`td.fs`.
- `sclm=true` responses set `window.td` from `performance.timing`.

---

## Wire diff log (still valid as hygiene)

| Fix | File / probe |
|-----|----------------|
| In-session Downlink/RTT 1.7/100 | `HttpProfile.zig` |
| Omit all Sec-Fetch on in-session hops | `HttpProfile.zig` |
| `search_q_only` referer | `NavigationPlanner.zig` |
| `google.tick`, inject `google` patch | `GoogleCompat.zig`, `Frame.zig` |

Doc-type divergence (bootstrap vs SERP at `sei`) **not explained by referer/cookie wire on in-session hops alone** — hop-1 tier already decided.

---

## Investigation Commands

```bash
cd /Users/huydev/Desktop/velora
node google-search-debug/scripts/export-chrome-live-cookies.mjs
node google-search-debug/scripts/run-google-search-with-session.mjs --query "velora"
node google-search-debug/scripts/probe-cookie-ablation.mjs
node google-search-debug/scripts/diff-hop1-request.mjs --query test
npm run google:sorry-parity -- --query "test-$(date +%s)"
```

---

## Lessons Learned (revised)

1. **Check jar before knitsail** — ~91 KB hop-1 means cold tier; export live cookies first.
2. **Two paths are not interchangeable** — sorry parity must note which path each engine took.
3. **Long-path JS fixes are conditional** — irrelevant when warmed jar yields short path.
4. **`sclm` / `ussv` / `sp` are server switches on low-trust HTML** — do not fake; warm session instead.

---

## References

- **Canonical journey:** `knowledge/captcha/detection/google-search-investigation-journey.md`
- `knowledge/bugs/2026-06-29-google-search-nid-trust-tier.md`
- `google-search-debug/scripts/export-chrome-live-cookies.mjs`
- `google-search-debug/scripts/google-search-top-results.mjs`