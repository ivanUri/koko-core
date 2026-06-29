# Google Search Investigation Journey — What We Thought, Tested, and Finally Understood

> **Canonical conclusion (2026-06-29):** Velora Google Search works when the session is **warmed with a mature Chrome cookie jar** (`NID` + signed-in session cookies). Cold start without that jar → long bootstrap path → `knitsail` / `sg_ss` / `/sorry`. Most earlier notes over-weighted fingerprint, knitsail JS, and wire-header diffs relative to this single gate.

This document replaces the *implicit narrative* scattered across older Google Search notes. Read this first; other files are kept for detail but may describe symptoms, not the primary fix.

---

## Phase 0 — Symptom

**What we saw**

- Velora antidetect profile on Google Search: often **long path** (~91 KB bootstrap HTML, `knitsail`, client redirect to `sei` or `sg_ss`, sometimes `/sorry`).
- Chrome on the same machine: often **short path** (SERP ~270–600 KB on hop 1 or fast `sei` SERP, **0× `knitsail.a`** in probes).
- CreepJS / canvas / audio / window-keys could be green while Google still blocked or sorry’d.

**Early intuition (wrong weighting)**

> “Google must be detecting our JS fingerprint. We need CreepJS parity, then search will work.”

That intuition sent us deep into fingerprint and bootstrap JS before we measured the **server trust tier** correctly.

---

## Phase 1 — “Fix fingerprint first” (CreepJS sweep)

### What we thought

Google uses the same class of signals as CreepJS: canvas, audio, WebGL, `window` keys, TLS JA3/JA4, navigator, fonts, etc. If Velora matches Chrome on CreepJS, Search should match.

### What we tested

- `cdp-creepjs-*` section compares (canvas, audio, window keys, client rects, maths, worker, …).
- Profile baselines from real Chrome (`chrome-local-huys-macbook-pro`).
- Window-keys prune fixes so `knitsail` is not deleted before bootstrap.

### What passed

- Many CreepJS sections improved or matched.
- `knitsail` surviving on `window` (window-keys allowlist) — **necessary** for long path, not sufficient for short path.

### What we realized

CreepJS green ≠ Google SERP. Google hop-1 is largely **server-chosen HTML shape** (bootstrap vs full SERP), not a client-side fingerprint score rendered in CreepJS. We were optimizing layer 4 while layer 0 (session trust) was empty.

**Verdict:** Fingerprint work is **real but secondary**. Do not block Search on CreepJS sweep completion.

---

## Phase 2 — “TLS / HTTP wire must be wrong”

### What we thought

Velora uses curl-impersonate; maybe JA3/JA4, ALPN, header order, `Sec-Fetch-*`, Downlink/RTT, referer on `sei` hops are wrong → Google downgrades us to automation tier.

### What we tested

- `capture-wire-search-hops.mjs`, `diff-hop1-request.mjs`, `diff-sei-request.mjs`.
- Chrome net-log vs Velora wire captures.
- Fixes: in-session Downlink/RTT (1.7/100), omit all `Sec-Fetch-*` on in-session hops, `search_q_only` referer, `x-browser` headers, h2 policy for `sg_ss`.

### What passed

- Wire diffs narrowed; Velora in-session headers closer to guest Chrome HAR.
- Some cold-IP runs reached SERP **without** matching every Chrome header on hop 1.

### What we realized

Wire parity is **necessary hygiene** but did not explain why **same IP, same query** produced ~91 KB bootstrap for Velora and ~270 KB SERP for Chrome. Headers alone do not flip `sclm` / bootstrap tier if the session cookie state differs.

**Verdict:** Keep wire fixes; stop treating them as the primary trust unlock.

---

## Phase 3 — “Bootstrap / knitsail / `pageT` / `google.tick` is the root cause”

### What we thought

Long path HTML always has `sclm=false`, `ussv=''`, `sp=''` → short-path JS branch fails → `la()` → `knitsail.a()` → `sg_ss`. If we fix:

- `pageT` freeze through async knitsail,
- `window.td` / `ha()` / `google.tick`,
- inject script patching `google` in-place,

…then encode will succeed and we’ll match Chrome’s path.

### What we tested

- `probe-bootstrap-hop2.mjs` — `pageT` at knitsail call ~303 ms vs Chroma ~192 ms.
- `probe-knitsail-io.mjs` — knitsail call counts per hop.
- `google.tick()` implementation, `td.qs`/`td.fs` seeding in `Frame.zig`.
- `sg_ss` curl replay, encode blob diffs.

### What passed

- `google.tick`, inject script, `pageT` tuning — improved long-path behavior; reCAPTCHA cfgClients parity on `/sorry`.
- Understanding of SGS script order (scripts 0–4, knitsail loader, `la()` branch).

### What we realized

We were **engineering the long path better** while Chrome often **never entered** that path. Fixing knitsail encode does not help if the server would have served SERP directly with a trusted session. Bootstrap bugs matter **only when you are already on the low-trust tier**.

**Verdict:** Knitsail/`pageT`/`td` fixes are **conditional** — relevant for cold/low-trust sessions, not the happy path.

---

## Phase 4 — “Sorry / path parity — make `/sorry` identical to Chrome”

### What we thought

Even on `/sorry`, Chrome and Velora must fail the same way (same document hops, same `continue` URL shape). Maybe parity there reveals the real bug.

### What we tested

- `npm run google:sorry-parity` — compare document timeline, `continue.hasSgSs`, recaptcha chain.
- `grecaptcha` / `HTMLElement.style` shim for cfgClients parity.

### What passed

- reCAPTCHA cfgClients parity (1 vs 1) after HTMLElement.style fix.
- Clear documentation: Chrome sorry often **search → sorry** (no `sei` 200); Velora sorry often **search → sei → sorry** with fat `sg_ss` in `continue`.

### What we realized

Sorry parity is a **valuable diagnostic** for path divergence, but optimizing `sg_ss` encode before earning **short path** is backwards. Chrome’s sorry path skips the long bootstrap when IP is hot; Velora’s sorry path often carries a **self-inflicted** `sg_ss` blob from long path.

**Verdict:** North-star for antibot forensics; not the first production fix.

---

## Phase 5 — “Velora has no cookies” (first cookie hypothesis)

### What we thought

Velora cold start sends **zero cookies** on hop 1; Chrome has `NID`, `AEC`, etc. Maybe injecting guest cookies flips trust tier.

### What we tested

- `export-chrome-cookies.mjs` — spawn **fresh** Chrome, visit `google.com`, export 4 cookies.
- `test-velora-chrome-cookies.mjs` — A/B no cookie vs guest cookie.
- `--cookie` on `spawnVelora`.

### What passed

- Velora **does** send cookies when `--cookie` / `--cookie-jar` loaded.
- Guest 4-cookie inject: cookies on wire (**438 B**), but **`sclm` still `false`**, ~91 KB bootstrap, 2 hops.

### What we realized

**Having cookies ≠ having trust.** Fresh Chrome `NID` is a different payload than a mature profile `NID`. Google decodes cookie state server-side; guest export is not warmup.

**Verdict:** Cookie hypothesis directionally right; **guest cookie export was the wrong experiment.**

---

## Phase 6 — Breakthrough: mature session cookie jar (warmup)

### What we thought (refined)

> “We need the user’s **real Chrome account session**, not a spawned guest profile.”

### What we tested

1. User curl with full session cookies (`NID` ~280 chars + `DV` + `__Secure-*`) → **271 KB SERP** in curl.
2. Same cookies in Velora → **~266 KB SERP**, 1 hop, `knitsail=0`.
3. **Cookie ablation** (`probe-cookie-ablation.mjs`):
   - Mature jar: **`NID` alone** → short path.
   - Remove `NID` → long path.
   - `DV` alone → long path; remove `DV` with mature `NID` → still short.
   - Guest `NID` only → always long path.
4. **Live export** (`export-chrome-live-cookies.mjs` via `browser-cookie3` + macOS Keychain):
   - **154 cookies**, `NID` length **1119**, includes `SID`/`SAPISID`/signed-in state.
5. Production probes:
   - `velora` search → **606 KB SERP**, title match, 1 hop.
   - `coingloo.com` → top 5 organic results parsed after jar refresh.

### What passed

| State | Hop-1 body | Hops | `knitsail` | SERP |
|-------|-----------|------|------------|------|
| Cold Velora (no jar) | ~91 KB | 2+ | yes | sometimes after sei |
| Warm Velora (mature jar) | ~266–606 KB | 1 | 0 | yes |

### What we finally understood

**Bản chất: warmup cookie jar.**

Google Search trust tier on cold `/search` is dominated by **mature session cookies** (especially `NID` and signed-in `SID` family), not by CreepJS fingerprint on first paint.

```
Cold Velora
  → server: low trust
  → ~91 KB bootstrap (sclm=false, empty ussv/sp)
  → knitsail pipeline
  → sei / sg_ss / sorry risk

Warm Velora (Chrome account jar)
  → server: high trust
  → full SERP on hop 1
  → no knitsail gate
  → parse results, done
```

This explains **months of apparent contradictions**:

- Same IP, different path → cookie/session state differed.
- Wire fixes helped marginally but did not flip tier → cookies were the flip.
- Knitsail fixes “worked” on long path but Chrome never needed them on short path.
- CreepJS parity unrelated to hop-1 HTML size → server already decided before client fingerprint ran.

---

## What older knowledge got wrong (or overstated)

| Old belief | Reality |
|------------|---------|
| “Primary blocker is knitsail / bootstrap JS” | Primary blocker is **cold session** (no mature jar). |
| “`sclm` / `ussv` / `sp` client bugs” | Server-set gates on **low-trust** HTML; don’t fake them — **earn tier with jar**. |
| “CreepJS sweep required for Google Search” | Helpful for antidetect product; **not** the Search unlock. |
| “Chrome guest vs Velora = fingerprint delta” | Often **cookie delta** + IP rate limit; guest Chrome also has no cookies on in-session hops. |
| “Copy Chrome profile dir for cookies” | macOS Keychain encrypts DB; copy yields **4 guest cookies**. Use **live export**. |
| “`DV` cookie required” | Optional when mature `NID` present. |
| “`--cookie-jar` persists session” | Was save-only; **load on start added 2026-06-29** — must export + jar round-trip. |

---

## What still matters (secondary, after warmup)

1. **Wire hygiene** — `Sec-Fetch`, Downlink/RTT on in-session hops, referer shape (see bootstrap-divergence §13–15).
2. **Long-path robustness** — knitsail, `pageT`, `google.tick`, window-keys allowlist — when jar expires or IP forces bootstrap.
3. **Sorry parity** — forensic compare when both engines should sorry; reCAPTCHA chain.
4. **IP rate limit** — parallel probes heat IP; sequential 20–30 s gaps; refresh jar if `sg_ss` appears.
5. **Fingerprint / CreepJS** — product quality, not Search tier gate.

---

## Production recipe (warmup)

Profile-baked session (agent-native, no CLI flags):

```json
// browser/profiles/chrome-local-huys-macbook-pro.json
"session": {
  "cookieSeedFile": "browser/profiles/assets/chrome-local-huys-macbook-pro-session-cookies.json",
  "cookieRuntimeFile": "browser/profiles/sessions/chrome-local-huys-macbook-pro-cookies.json"
}
```

```bash
cd /Users/huydev/Desktop/velora

# Provision once (refresh seed from Chrome account)
node google-search-debug/scripts/export-chrome-live-cookies.mjs \
  --out browser/profiles/assets/chrome-local-huys-macbook-pro-session-cookies.json

# Agent: just start Velora with profile — cookies auto-load
zig-out/bin/velora serve --browser-profile chrome-local-huys-macbook-pro

# Search (no --cookie / --cookie-jar flags)
node google-search-debug/scripts/google-search-top-results.mjs --query "coingloo.com"
```

**Bootstrap order:** runtime jar (if non-empty) → profile seed → CLI `--cookie` override.  
**Persist:** runtime jar + `.storage.json` on exit (skips empty jar).

**Re-export seed when:** hop-1 ~91 KB, `knitsail` returns, or `sg_ss` in URL.

---

## Investigation timeline (compressed)

| Order | Hypothesis | Test | Outcome |
|-------|------------|------|---------|
| 1 | Fingerprint / CreepJS | section compares | pass sections, **Search still long path** |
| 2 | TLS / wire headers | wire diff scripts | closer wire, **tier unchanged** |
| 3 | knitsail / pageT / td | bootstrap probes | better long path, **Chrome still 0 knitsail** |
| 4 | Sorry parity | sorry-parity compare | path divergence documented |
| 5 | Guest cookies | 4-cookie A/B | cookies sent, **still bootstrap** |
| 6 | Mature session jar | ablation + live export | **short path, SERP, top results** ✓ |

---

## Related notes (read with caution)

| File | Status |
|------|--------|
| **This file** | **Canonical narrative** |
| `bugs/2026-06-29-google-search-nid-trust-tier.md` | Technical detail for Phase 6 |
| `bugs/2026-06-29-google-search-bootstrap-divergence.md` | Long-path symptom catalog; **superseded as root-cause story** |
| `captcha/detection/google-search-flow-architecture.md` | Path machine diagram; add “tier decided by jar” |
| `captcha/detection/google-search-signal-inventory.md` | Layer list; Layer 0 (cookies) is now **primary** |
| `bugs/2026-06-29-google-search-knitsail-window-keys-prune.md` | Valid long-path fix |
| `bugs/2026-06-29-grecaptcha-htmlelement-style-shim.md` | Valid sorry-path fix |

---

## Lessons (durable)

1. **Measure hop-1 body size first** (~91 KB vs ~270 KB) — instant trust-tier thermometer.
2. **Ablation beats theory** — `NID`-only vs guest `NID` ended the debate.
3. **Do not optimize knitsail before earning short path** — fight the war you’re in.
4. **Warmup is operational, not code magic** — export jar from real Chrome; persist with `--cookie-jar`.
5. **Old knowledge documents symptoms well** — this journey doc explains **which symptoms mattered for production**.