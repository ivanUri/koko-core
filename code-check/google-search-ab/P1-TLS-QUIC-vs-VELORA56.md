# P1 TLS/QUIC vs Chrome Profile `velora56` (Profile 56)

**Date:** 2026-07-17  
**Goal:** Close cold-path TLS gaps so Velora matches Chrome profile velora56 without cookies.

## Chrome Profile 56 baseline

- Name: `velora56`, dir: `Profile 56`
- Browser: system Chrome **150** (same binary for all profiles)
- Pre-search cookies: `NID` + `__Secure-STRP` only (auto-set on profile create)
- TLS/QUIC: identical to any cold Chrome 150 on this machine (profile does not change ClientHello)

## Diff matrix (Chrome 150 / P56 vs Velora = curl-impersonate **chrome146**)

| Signal | Chrome P56/150 | Velora chrome146 | Closable in Velora Zig? |
|--------|----------------|------------------|-------------------------|
| JA3n / ciphers / groups (ML-KEM) | ✅ | ✅ match | Already OK |
| Akamai H2 SETTINGS | ✅ | ✅ match | Already OK |
| QUIC JA4 + h3_text | ✅ | ✅ match | Already OK |
| **JA4 TCP** | `…_806a8c22fdea` | `…_d8a2da3f94cd` | **No** — need ML-DSA 0904/05/06 in BoringSSL |
| **sigalgs** | `0904,0905,0906,0403,…` | `0403,0804,…` only | **No** — `mldsa44` / `0x0904` → `Unknown signature hash algorithm` |
| **ECH** | success, outer `quic-outer.browserleaks.com` | fail unless special CLI | **Partial** — see below |
| Max impersonate profile | real 150 | **chrome146** (max in vendor; no chrome147–150) | Vendor bump required |

## What we tried

### 1. Signature algorithms (JA4 TCP)

```bash
curl-impersonate --impersonate chrome146 --signature-hashes 'mldsa44:…'
# → curl: (43) Unknown signature hash algorithm: 'mldsa44'
```

Upstream **lexiforest/curl-impersonate@v2.0.0rc3** still ships max **`curl_chrome146`** only — no chrome150 target.

### 2. ECH (match Chrome `ech_success`)

| CLI | Result |
|-----|--------|
| chrome146 default | `ech_success=false`, outer=quic.browserleaks.com |
| `--ech true --doh-url https://cloudflare-dns.com/dns-query` | **`ech_success=true`**, outer=`quic-outer.browserleaks.com` ✅ = Chrome |
| Same knobs in Velora `applyChromeTlsKnobs` (multi) | **segfault @0x8** on first request |
| `--ech grease` only in multi | no crash but no ECH success; may disturb h3 |

**Conclusion:** ECH parity is proven on **CLI single-handle**, not safe on **Velora curl multi** with this vendor build.

### 3. Google Search cold (empty jar) after knobs

CLI with ECH+DoH + h3 still ~91KB knitsail — **ECH alone does not unlock SERP**.  
Chrome P56 still SERPs with real stack; Velora cold still bootstrap.

## Code left in tree

- `libcurl.zig`: `doh_url`, `ssl_sig_hash_algs` option bindings + constants for future enable  
- `http.zig` `applyChromeTlsKnobs`: comments documenting P1 blockers; **no crashy ECH/DoH by default**  
- Google Search document still prefers **h3** (earlier fix)

## Update 2026-07-17 (after v2.0.0rc3 + ML-DSA)

| Item | Status |
|------|--------|
| TCP JA4 / ML-DSA | ✅ closed (`chrome150` knobs, vendor v2rc3) |
| QUIC JA4 | ❌ still open — see below |
| Cold Google empty jar | ❌ knitsail (hop-1 **h3**) |

### QUIC remaining (browserleaks live capture)

- Chrome: `q13d0311h3_…` · h3_text `…|GREASE|984832|m,a,s,p` · sigs **no** ML-DSA, has `0201`
- curl: `q13d0313h3_…` · extra ext **0005+0012** · h3_text missing PRIORITY_UPDATE · stock tarball **without** Velora H3 patches
- Applying TCP ML-DSA also polluted QUIC (HTTP3_SIG opt does not override) → fixed in `applyChromeTlsKnobs` (**ML-DSA only on h2**)

Full write-up: `knowledge/fingerprint/tls/2026-07-17-quic-h3-chrome150-vs-curl.md`

## Recommended path to actually close P1

1. **Vendor rebuild** from source: v2.0.0rc3 **+** `vendor/curl-impersonate-patches/velora-h3-fingerprint-*.patch` (restore GREASE + PRIORITY_UPDATE 0x0f0700).  
2. **QUIC ClientHello:** drop ext **0005/0012** on QUIC to match Chrome 11-ext template; optional trailing **0201**.  
3. Keep TCP ML-DSA for h2; **never** inject ML-DSA on h3 (already in `http.zig`).  
4. ECH+DoH multi-safe (secondary — alone does not unlock SERP).  
5. **Gate:** empty-jar Google hop-1 h3 + QUIC JA4≈Chrome + `htmlLen>250k`.  
6. Until QUIC parity: cookie pipeline remains production Search unlock (**bypass**, not root cause).

## Update 2026-07-17 (header + knob cleanup)

HTTP hop-1 identity cleaned to match Chrome 150 ExtraInfo (`uaFullVersion` 129, `X-Browser-Validation` captured token, ML-DSA setopt fallback). See `knowledge/fingerprint/tls/2026-07-17-chrome150-fingerprint-cleanup.md`.

| Gate | Status after cleanup |
|------|----------------------|
| Header CH + X-Browser vs Chrome 150 | ✅ matched on wire |
| empty-jar SERP | ❌ still knitsail |
| thin jar SERP | ✅ profile55 / fail-thin |
| Vendor `mldsa44` on this machine | ❌ unknown → fallback chrome146 list |

## Profile 56 takeaway

P56 does **not** use a special TLS profile — it uses Chrome 150 system stack. Matching “velora56” = matching **Chrome 150 ClientHello/ECH**, not matching its 2 cookies (those alone already failed on Velora).

