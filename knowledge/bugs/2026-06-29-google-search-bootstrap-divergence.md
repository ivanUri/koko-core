# Google Search Bootstrap Divergence: Velora sg_ss Path vs Chrome sei Short Path

> **⚠️ Superseded as root-cause narrative (2026-06-29).**  
> Read first: [`google-search-investigation-journey.md`](../captcha/detection/google-search-investigation-journey.md)  
> **Primary fix:** warmup mature Chrome cookie jar (`NID` + session cookies). Cold Velora → long bootstrap path documented below. Warm Velora → short SERP hop-1; knitsail sections often **do not apply**.

## Summary

Velora **without a warmed cookie jar** consistently took Google's **knitsail / sg_ss long path**: ~91 KB bootstrap HTML, inline script chain, client-side `sei` or `sg_ss` redirects, and elevated `/sorry` rates on flagged IPs. Chrome with a **trusted session** on the same machine often received a **short path**: full SERP on hop 1 (~270–600 KB), zero `knitsail.a()` invocations, single document navigation. TLS fixes, wire-header alignment, `pageT` freeze, `google.tick`, and knitsail survival were all **real improvements for the long path** — but they could not convert a server-assigned low-trust tier into short-path HTML. Session cookie state (mature `NID`) is the main tier flip. This document remains the authoritative **long-path symptom catalog** and wire-diff log; it is not the production unlock story.

---

## Problem

After fixing TLS (JA4/JA3n/Akamai/QUIC impersonation) and knitsail window-keys pruning, Velora **still** hit the long path and `/sorry` when the cookie jar was empty. Chrome with mature cookies on the same IP and query got SERP on hop 1. The failure mode was confusing because many antidetect signals looked healthy:

| Checkpoint | Chrome (warm session) | Velora (cold jar) |
|------------|----------------------|-------------------|
| Hop-1 body | ~270–600 KB SERP | ~91 KB bootstrap |
| `knitsail.a()` calls | **0** | **1–4×** |
| Document hops | 1 (or fast sei SERP) | 2+ (bootstrap → sei/sg_ss) |
| `sclm` in HTML | absent | `false` + empty `ussv`/`sp` |
| CreepJS sections | N/A for Search | many green, Search still long |

From a browser architecture perspective, Google Search is not a single `Navigation` → `Document` pipeline. It is a **multi-hop state machine** where hop-1 response type predetermines which client scripts run, which network requests fire, and whether reCAPTCHA enterprise loads on `/sorry`. Velora and Chrome were entering **different branches of the same state machine** — not merely executing the same branch with different timing.

The long path feels like a client bootstrap failure (missing `knitsail`, wrong `pageT`, bad encode blob). In reality, the server already committed to bootstrap tier **in the HTML bytes of hop 1**. Client engineering can only optimize traversal of that branch — or you warm the session so the server never serves that branch.

---

## Root Cause

### Primary — cold session (no mature cookie jar)

Google selects trust tier **before** inline bootstrap JavaScript executes. The decision is encoded in hop-1 HTML shape:

- **High trust:** full SERP document, large body, no `sclm`/`ussv`/`sp` gate variables, no `knitsail` loader references.
- **Low trust:** compact bootstrap shell, `sclm=false`, empty `ussv` and `sp`, inline knitsail closure, deferred `la()` → `ia()` chain.

Mature `NID` (+ signed-in session cookies) flips to high trust. Guest or absent jar stays low trust. See [`2026-06-29-google-search-nid-trust-tier.md`](./2026-06-29-google-search-nid-trust-tier.md) and `probe-cookie-ablation.mjs` for the ablation matrix.

### Secondary — long-path client behavior (only when tier is already low)

When already on bootstrap HTML, these gaps caused additional degradation:

1. **Hop-1 `sclm=false`** → `window.td` not populated → `ha()` returns empty timing payload.
2. **`pageT` at `knitsail.a()`** ~303 ms vs Chrome ~192 ms target — encode timing fingerprint drift.
3. **`knitsail` pruned** from `window` at `DOMContentLoaded` before async bootstrap called `ia()` — see knitsail window-keys note.
4. **Wire gaps on in-session `sei` hops** — Downlink/RTT, `Sec-Fetch-*` omission policy, referer shape.

None of these explain why Chrome got SERP on hop 1 with the same query. They explain why Velora's long path was **worse than necessary** once already on that path.

---

## Investigation

### Long-path gate mechanics

Google's SGS bootstrap evaluates a short-path promise before falling back to knitsail:

```javascript
window.sgs && ussv && sp
  ? window.sgs(sp).then(ok => { /* short path — full client bootstrap */ })
  : Promise.resolve(false);
Z.then(a => a || la());  // la() → knitsail → sg_ss redirect
```

Captured cold Velora hop-1 always had `ussv=''`, `sp=''` → short-path branch never runs → `la()` always executes.

### `pageT` / `google.tick` / `td` (long-path timing layer)

On bootstrap HTML, `sclm=true` responses populate `window.td` from `performance.timing`. Cold tier serves `sclm=false`, leaving `td` empty. Velora implemented:

- `pageT` freeze covering async knitsail chain (so encode sees stable elapsed time).
- `google.tick()` in `GoogleCompat.zig` with inject script seeding `td.qs` / `td.fs`.
- `Chrome.csiPageT` preferring frozen knitsail window over epoch delta.

`probe-bootstrap-hop2.mjs` documented `pageT` at knitsail call ~303 ms vs Chroma ~192 ms before tuning.

### Wire diff log (hygiene — still valid)

| Fix | Component | Effect |
|-----|-----------|--------|
| In-session Downlink/RTT 1.7/100 | `HttpProfile.zig` | Matches guest Chrome HAR |
| Omit all Sec-Fetch on in-session hops | `HttpProfile.zig` | Policy-aligned guest behavior |
| `search_q_only` referer | `NavigationPlanner.zig` | sei hop referer shape |
| `google.tick`, inject `google` patch | `GoogleCompat.zig`, `Frame.zig` | long-path timing payload |

Doc-type divergence (bootstrap vs SERP at `sei`) was **not** explained by referer/cookie wire on in-session hops alone — hop-1 tier was already decided.

### Investigation commands

```bash
cd /Users/huydev/Desktop/velora

# Session export and warmed navigation
node google-search-debug/scripts/export-chrome-live-cookies.mjs
node google-search-debug/scripts/run-google-search-with-session.mjs --query "velora"

# Tier ablation
node google-search-debug/scripts/probe-cookie-ablation.mjs

# Hop-1 wire diff
node google-search-debug/scripts/diff-hop1-request.mjs --query test

# End-to-end sorry parity (long vs short path aware)
npm run google:sorry-parity -- --query "test-$(date +%s)"

# Knitsail timing
node google-search-debug/scripts/probe-knitsail-io.mjs
node google-search-debug/scripts/probe-bootstrap-hop2.mjs
```

### Diagnostic decision tree

1. **Hop-1 body < 100 KB?** → cold tier. Export mature cookies before knitsail debugging.
2. **`knitsail` undefined at DCL?** → window-keys prune bug (long-path prerequisite).
3. **`sg_b_e=Error: f` beacon?** → knitsail missing at `ia()` time.
4. **Hop-1 body > 250 KB, still `/sorry`?** → IP/reputation or post-SERP gate — different problem class.

---

## Solution

### Production unlock (primary)

Warm Velora with mature Chrome cookie jar. See NID trust tier note for export/serve commands. Short path eliminates most knitsail/`pageT`/`sg_ss` engineering surface.

### Long-path improvements (conditional)

When cold tier is unavoidable (fresh IPs, expired `NID`, automation without profile sync):

| Area | Action |
|------|--------|
| Window globals | Add `knitsail`, `td` to `runtimeAssigned` in `WindowKeysIntelligent` |
| Timing | `pageT` freeze, `google.tick()`, `td` seeding |
| Wire | Downlink/RTT, Sec-Fetch policy, referer on sei hops |
| Sorry DOM | `HTMLElement.style` shim for reCAPTCHA cfgClients |

### What not to do

- Do not fake `ussv`/`sp`/`sclm` in client JS — server already chose tier.
- Do not assume sorry parity on cold path equals Chrome sorry parity on warm path — document which branch each engine took.

---

## Lessons Learned

1. **Check jar before knitsail.** ~91 KB hop-1 means cold tier; export live cookies first.
2. **Two paths are not interchangeable.** Sorry parity and bootstrap probes must record path class (long vs short).
3. **Long-path JS fixes are conditional.** Irrelevant when warmed jar yields short path with `knitsail=0`.
4. **`sclm` / `ussv` / `sp` are server switches on low-trust HTML** — outputs, not inputs.
5. **TLS and CreepJS are hygiene layers.** Necessary for overall antidetect quality; insufficient for Search tier alone.
6. **Investigation journey ordering matters.** We spent Phases 1–3 optimizing client behavior before measuring server tier in Phase 6 — expensive sequencing mistake.

---

## References

- **Canonical journey:** [`google-search-investigation-journey.md`](../captcha/detection/google-search-investigation-journey.md)
- **Flow architecture:** [`google-search-flow-architecture.md`](../captcha/detection/google-search-flow-architecture.md)
- **Signal inventory:** [`google-search-signal-inventory.md`](../captcha/detection/google-search-signal-inventory.md)
- [`2026-06-29-google-search-nid-trust-tier.md`](./2026-06-29-google-search-nid-trust-tier.md)
- [`2026-06-29-google-search-knitsail-window-keys-prune.md`](./2026-06-29-google-search-knitsail-window-keys-prune.md)
- [`2026-06-29-grecaptcha-htmlelement-style-shim.md`](./2026-06-29-grecaptcha-htmlelement-style-shim.md)
- `google-search-debug/scripts/export-chrome-live-cookies.mjs`
- `google-search-debug/scripts/google-search-top-results.mjs`
- Velora: `src/core/webapi/Chrome.zig`, `src/runtime/profile/WindowKeysIntelligent.zig`

---

## Related Knowledge

- [Google Search NID trust tier](./2026-06-29-google-search-nid-trust-tier.md) — primary tier flip mechanism
- [Google Search knitsail window-keys prune](./2026-06-29-google-search-knitsail-window-keys-prune.md) — DCL pruning vs async bootstrap
- [CreepJS TLS JA3/JA4 parity](../fingerprint/tls/creepjs-tls-ja3-ja4-parity.md) — Phase 2 wire work
- [Window features `opn` hook](../fingerprint/navigator/window-features-opn-hook.md) — same WindowKeysIntelligent subsystem
- [CreepJS navigator parity](../fingerprint/navigator/creepjs-navigator-parity.md) — antidetect install timing