# Deep analysis: Why cold Chrome SERPs without cookies, but cold Velora does not

**Date:** 2026-07-16  
**Evidence:** A/B run `runs/2026-07-16T15-14-57-821Z` + cold Chrome capture `runs/chrome-cold-compare/`

---

## 1. Correct the mental model

| Claim | Verdict |
|-------|---------|
| “Must have Chrome Profile cookies to search” | **False for real Chrome.** Cold Chrome hop-1 sends **0 Cookie bytes** and still ends on SERP. |
| “IP ban explains Velora cold fail” | **False on this host.** Same machine: cold Chrome SERP; cold Velora bootstrap. |
| “Mature cookies fix Velora” | **True as a *trust bypass***, not as the root wire bug. Cookies raise server tier so remaining Velora signals are ignored. |
| “Header order is the cold-path root cause” | **Unlikely.** Cold Chrome vs cold Velora Accept-first lists match aside from `X-Client-Data` (Chrome only) and brand/UA major. |

**Working model**

```
Google hop-1 chooses HTML tier using a score of many signals.

  Chrome cold:  score ≥ SERP threshold  → fat SERP (even Cookie=0)
  Velora cold:  score < threshold       → ~91 KB knitsail bootstrap
  Velora+P45:   cookie trust dominates  → fat SERP (bypasses other gaps)

Mature cookies are a *crutch*. They do not prove wire parity.
```

---

## 2. Triple comparison (same query `velora browser`)

| Signal | Cold Chrome | Cold Velora (empty jar) | Velora + Profile 45 jar |
|--------|-------------|-------------------------|-------------------------|
| Hop-1 Cookie bytes | **0** | **0** | **~2596** |
| Final tier | **SERP** | **knitsail bootstrap** | **SERP** |
| htmlLen (final) | ~994 KB | ~91 KB | ~365 KB |
| knitsail in HTML | no | **yes** | no |
| Document protocol | **h3** | **h2** | **h2** |
| Sec-Fetch-Site hop-1 | none | none | none |
| X-Client-Data | **yes** | no | no |
| UA major | Chrome/**150** | Chrome/**149** | Chrome/**149** |
| sec-ch-ua brands | `Not;A=Brand`;v=8 / Chromium 150 | `Not)A;Brand`;v=24 / Chrome 149 | same as cold Velora |
| TLS impersonate | real Chrome 150 | curl-impersonate **chrome146** nearest | same |
| Same host IP | yes | yes | yes |

### Cold Chrome path (works without prior cookies)

1. Hop-1 document **Cookie empty**, protocol **h3**, has **X-Client-Data**.
2. Server still returns navigable search HTML (then **sei=** hop).
3. sei hop carries cookies Google *just set* (`AEC`, `NID`, …) ~2 KB.
4. Final page: title SERP, `rso`, large HTML.

### Cold Velora path (fails)

1. Hop-1 document **Cookie empty**, protocol **h2**, no X-Client-Data.
2. Server returns **~91 KB bootstrap** with `knitsail` / `sclm` / `ussv` markers (low-trust shell).
3. Long path may continue to `sei` / `sg_ss` / `/sorry` on other runs; this A/B stop was bootstrap.

### Velora + mature jar (works)

1. Hop-1 Cookie includes SID / `__Secure-*PSID` / NID≈791 / SAPISID…
2. Server returns SERP **on hop-1** (1 hop), no knitsail.
3. Proves: **session trust overrides** cold-path demotion for this IP.

---

## 3. Where in Velora the cold path is decided (call chain)

This is not a single “bug function.” Tier is chosen **by Google’s server** after Velora emits the hop-1 request. The *emit* path is:

```
Frame.navigate
  → cookie_jar.beginDocumentNavigation()
  → profile_runtime.navigationPlan()          // google-search.json
  → headersForRequest()                       // Frame.zig
       → HttpProfile.appendChromeHeaders()    // Accept-first list
       → HeaderPlugins x-browser              // X-Browser-* only
  → HttpClient.request / Transfer.configureConn
       → Request.getCookieString()            // Cookie.forRequest
            → originBindingMatches()          // source_secure (restore bug fixed)
       → applyProfileTransportVersion(...)    // TLS + HTTP version
            → document ⇒ force **h2**         // ⚠️ Chrome cold uses **h3**
       → conn.setHeaders / perform
```

### Functions that matter

| Layer | File | Function / site | Role |
|-------|------|-----------------|------|
| Nav policy | `NavigationPlanner.zig` | `navigationPlan` / `applyPolicy` | sei inject, omitSecFetchUser, cookies policy |
| Headers | `Frame.zig` | `headersForRequest` | Builds Chrome document header list |
| Headers | `HttpProfile.zig` | `appendChromeDocumentNavigationHeaders` | Accept-first, Sec-Fetch, CH |
| Cookies | `HttpClient.zig` | `Request.getCookieString` | Attach Cookie header |
| Cookies | `Cookie.zig` | `Jar.forRequest` / `originBindingMatches` | Domain + **source_secure** filter |
| Cookies load | `cookies.zig` | `loadFromFile` | JSON → jar (**must** set `source_secure=true`) |
| Transport | `HttpClient.zig` ~2501 | `resource_type == .document → .h2` | **Cold Chrome uses h3** |
| TLS | `TransportProfile.zig` | `Target.resolve` → chrome146 | Max impersonate profile |
| Plugin | `XBrowser.zig` | `appendHeaders` | X-Browser-*; **not** X-Client-Data |

### Known fixed bug (cookie crutch was broken)

`cookies.loadFromFile` used to leave `source_secure=false` → HTTPS requests dropped **all** restored cookies (`originBindingMatches`). That made “warmup Profile 45” appear flaky. Fixed 2026-07-16.  
See `knowledge/bugs/2026-07-16-cookies-json-source-secure-https-drop.md`.

That bug does **not** explain cold Chrome vs cold Velora (both Cookie=0 on hop-1).

---

## 4. Best remaining cold-path hypotheses (ranked)

Not proven as sole cause; ordered by evidence strength on this machine:

1. **HTTP version: h2 (Velora document) vs h3 (Chrome search)**  
   - Code: `HttpClient.configureConn` forces `.h2` for all document navigations.  
   - Comment cites ebay HAR / curl status=0 on h3.  
   - Google Search cold Chrome clearly uses **h3**.

2. **TLS / JA3 stack = curl-impersonate chrome146, not Chrome 150**  
   - UA/brands claim 149; wire TLS is 146-class.  
   - CreepJS JA4 may match; Google may use additional QUIC/TLS features.

3. **Missing `X-Client-Data`**  
   - Present on every Chrome cold document hop; never sent by Velora.  
   - Variation / Finch cookie; hard to spoof correctly; may be secondary.

4. **Client Hints brand grammar**  
   - Chrome 150: `"Not;A=Brand";v="8"`  
   - Velora 149 profile: `"Not)A;Brand";v="24"`  
   - Grease brand format changes by major; mismatch is a classic signal.

5. **Post-hop-1 JS long path** (knitsail / pageT / sg_ss)  
   - Only runs when already on low-trust HTML.  
   - Improving knitsail does not unlock cold SERP; it optimizes the failure path.

6. **IP**  
   - Ruled out as sole cause when cold Chrome SERPs on same host.

---

## 5. Why Profile 45 cookies “fixed” search

- Not because Google *requires* cookies for everyone.
- Because a **logged-in / mature session cookie set** is a high-weight trust feature.
- With SID / PSID / fat NID, Google skips the antibot bootstrap shell for that request class.
- Same pattern as investigation journey Layer 0 (session cookies).

So: cookies are the **most reliable operational unlock today**, not the deepest correctness fix.

---

## 6. Options for stable search **without depending on the user’s Chrome profile**

### A. Cookie sources that are not “your Profile 45” (still cookies, not Chrome app)

| Approach | Stability | Notes |
|----------|-----------|--------|
| Dedicated Google accounts → export jar via automation (Playwright real Chrome headful once) | High | Cookies refresh on a schedule; Velora only loads `Cookies.json` |
| Cookie provider / residential session service | Medium–High | Cost; ToS; still cookie-based |
| Warmup **inside** Velora over days (browse google.com, consent, search lightly) | Low–Medium | Only works if cold path eventually earns cookies; currently cold is demoted so may never earn |

### B. Real Chrome transport for search only (already partially wired)

- Policy: `google-search.json` → `externalTransport` + config `google_chrome_transport`.
- Code: `GoogleChromeTransport.zig` / `chrome-google-transport.mjs`.
- Velora orchestrates; **Chrome does hop** → inherits real TLS/h3/X-Client-Data.
- Stable for Search; **depends on Chrome binary**, not on a mature profile if cold Chrome works (it does).
- Use when product can ship/sidecar Chromium.

### C. Close cold-path wire gaps (no Chrome, no cookies) — hard R&D

Priority experiments (each A/B against empty jar):

1. **Allow HTTP/3 for `www.google.com/search` document** (override the global document→h2 force). Measure SERP rate vs status=0 regressions.  
   - Touch: `HttpClient.zig` ~2501.
2. Align **UA + Sec-CH-UA grease brands** to host Chrome major (150).  
   - Profile catalog / Spoofing brands.
3. Evaluate **X-Client-Data** generation (or omit consistently only if cold Chrome can work without it — it cannot omit today; Chrome always sends).  
4. Re-verify JA4/h3 vs live Chrome 150 on google.com specifically (not only browserleaks).

Success metric: **empty jar, 1–2 hops, htmlLen > 250 KB, knitsail=0**, same IP.

### D. Product strategy if cold path stays hard

| Mode | Behavior |
|------|----------|
| **Session mode** | Require injectable cookie jar (from any source); document that Search needs Layer 0. |
| **Chrome sidecar mode** | Search navigations via real Chrome transport. |
| **Degraded mode** | Accept bootstrap/sorry; human/CAPTCHA pipeline (not pure automation). |

Do **not** promise “zero cookie, pure Velora curl” for Google Search until cold A/B matches Chrome.

---

## 7. Recommended next experiments (this folder)

```bash
# Baseline (already have)
npm run google:search-ab

# TODO harness extensions:
# 1) chrome-cold lane auto (see runs/chrome-cold-compare/)
# 2) velora-cold-h3 experiment branch
# 3) brand/UA 150 profile cold
```

For each experiment log: hop-1 protocol, cookieBytes, htmlLen, knitsail, tier.

---

## 8. Short answers

**Q: Why does fresh Chrome without cookies still search?**  
A: Google trusts cold Chrome’s **TLS/QUIC (h3) + client stack + X-Client-Data + brands**. Hop-1 Cookie can be empty; SERP still served (often via sei).

**Q: Where is the “error”?**  
A: Not a thrown exception. **Server returns a different HTML product** for Velora cold. Client path that shapes hop-1 is `Frame.navigate` → `headersForRequest` → `HttpClient.configureConn` (especially **document forced h2** + **chrome146 impersonate** + no X-Client-Data). Cookie restore bug was a separate issue for the “warmup works” story.

**Q: Stable without depending on user’s Chrome profile?**  
A: Yes, three productizable paths:  
1) **External cookie jar** (accounts/service, not Profile 45),  
2) **Chrome/Chromium sidecar** for search hops only,  
3) **Cold-path wire parity R&D** (h3 + brands + TLS) until empty-jar A/B matches Chrome.

---

## 9. Artifact pointers

- A/B OK vs empty jar: `runs/2026-07-16T15-14-57-821Z/REPORT.md`
- Cold Chrome: `runs/chrome-cold-compare/chrome-cold-snapshot.json`, `chrome-cold-docs.json`
- Cookie restore bug: `knowledge/bugs/2026-07-16-cookies-json-source-secure-https-drop.md`
- Header order work: `knowledge/captcha/detection/2026-07-16-google-search-chrome150-header-order.md`

---

## 10. Fix attempts (2026-07-16 evening) — results

| Change | Code / config | Cold empty jar result |
|--------|---------------|------------------------|
| Google Search document → **HTTP/3** | `HttpClient.configureConn` | protocol=h3 ✓; still knitsail ~91 KB |
| **X-Client-Data: CM76ygE=** | `XBrowser.appendHeaders` | header present ✓; still knitsail |
| Brand order grease-first + **Chrome 150** UA/brands | template + catalog fingerprint | sec-ch-ua matches live Chrome 150 style ✓; still knitsail |
| Mature Profile 45 jar (control) | export + `source_secure` fix | **SERP** ~369 KB, hop-1 Cookie ~2.5 KB |

**Conclusion after fixes:** remaining cold demotion is almost certainly **below HTTP headers** (QUIC/TLS fingerprint of curl-impersonate chrome146 vs real Chrome 150 stack). Header/protocol surface is largely aligned; empty-jar SERP is **not** unlocked yet.

**Stable production path today:** inject mature session cookies (any source, not necessarily user Profile 45) **or** Chrome sidecar transport. Continue QUIC/TLS R&D for true cold parity.

Test dump: `runs/FIX-TEST-SUMMARY.json`, `runs/cold-chrome150-align/`, `runs/warm-p45-after-cold-fixes/`.
