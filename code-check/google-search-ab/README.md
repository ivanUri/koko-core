# Google Search A/B debug (Velora)

Controlled comparison of **two Velora runs on the same machine**:

| Lane | Cookie jar | Expected tier |
|------|------------|---------------|
| **OK** | Mature Chrome **Profile 45** export | SERP (~300–400 KB HTML, 1 hop) |
| **FAIL** | Empty `Cookies.json` | bootstrap / `sei` / `sg_ss` / `/sorry` |

**Constants:** same `velora` binary, same antidetect profile (`chrome-local-huys-macbook-pro`), same query, same host IP.

This folder is the working area for forensics and discussion — not a unit test.

## Quick start

```bash
cd /Users/huydev/Desktop/velora
# needs: zig-out/bin/velora, browser-cookie3 venv, Chrome Profile 45

node code-check/google-search-ab/run-ab.mjs
node code-check/google-search-ab/run-ab.mjs --q "velora browser"
node code-check/google-search-ab/run-ab.mjs --skip-export   # reuse current jar for OK
```

Latest stamp: `runs/LATEST`  
Full report: `runs/<stamp>/REPORT.md`

## Layout

```
code-check/google-search-ab/
  README.md
  run-ab.mjs              # orchestrator
  lib/
    capture.mjs           # one lane: wire + CDP + HTML + jar
    report.mjs            # REPORT.md + diff.json
  runs/
    LATEST                # timestamp string
    <timestamp>/
      run-config.json
      SUMMARY.txt
      REPORT.md           # human report
      diff.json           # machine-readable
      ok/
        meta.json
        wire.ndjson       # VELORA_WIRE_HEADERS capture
        wire-summary.json
        network.json      # CDP Network.* timeline
        snapshot.json     # DOM signals / results
        page.html
        velora.stderr.log
        cookies-jar-before.json
        Cookies.json      # jar used for this lane
      fail/
        … same shape …
```

## What each capture includes

1. **Cookie jar snapshot** before navigate (counts, NID lengths, SID present)
2. **`Cookie.loadFromFile` log lines** from Velora stderr
3. **Wire request headers** per search hop (`initial` / `sei` / `sg_ss`): order, Cookie bytes/names, Sec-Fetch, Downlink/RTT, Accept-Encoding
4. **CDP Network timeline** (document requests/responses, status, protocol, encoded length)
5. **Page snapshot**: tier (SERP / sorry / knitsail), htmlLen, results, markers (`sclm`, scripts)
6. **Full HTML** for offline grep

## Report sections (REPORT.md)

1. Cookie jar before nav  
2. Hop-1 Cookie header  
3. Document hop path  
4. Hop-1 header order (LCS)  
5. Page outcome  
6. HTML markers  
7. CDP document responses  
8. Interpretation notes  
9. Artifact index  

## Parallel SERP case matrix (until Velora SERP)

Isolated jars + parallel Velora captures; stops on first `serp_ok`.

```bash
cd /Users/huydev/Desktop/velora
npm run google:serp-matrix                          # saved jars, concurrency 3
npm run google:serp-matrix -- --only profile55
npm run google:serp-matrix -- --wave live           # live Chrome P45/55/56/57 export
npm run google:serp-matrix -- --wave all --no-stop  # full matrix, no early stop
```

Artifacts: `code-check/tmp/serp-case-matrix/<stamp>/MATRIX.json`.

## Reverse A/B: Velora jar+URL → real Chrome

Complementary experiment: **do not** clone Chrome into Velora — import **Velora’s cookie jar + search URL** into a **temp Chrome** profile and compare verdicts.

```bash
cd /Users/huydev/Desktop/velora

# Fail lane (often knitsail) → Chrome
npm run google:replay-chrome -- --from code-check/google-search-ab/runs/<stamp>/fail

# OK / mature jar → Chrome (control)
npm run google:replay-chrome -- --from code-check/google-search-ab/runs/<stamp>/ok

# Named capture dirs
npm run google:replay-chrome -- --from code-check/google-search-ab/runs/profile55-search
npm run google:replay-chrome -- --empty --q "velora browser"

# Explicit jar + URL
node scripts/velora-replay-to-chrome.mjs --jar path/Cookies.json --url 'https://www.google.com/search?q=velora'
```

Artifacts: `code-check/tmp/velora-replay-to-chrome/<stamp>/REPORT.json` (+ `SUMMARY.txt`, `page.html`).

| Velora | Chrome (same jar+URL) | Read as |
|--------|------------------------|---------|
| knitsail | knitsail | state/IP — not only TLS |
| knitsail | SERP | stack gap (P1 TLS/browser) |
| SERP | SERP | state good for both |
| empty jar | SERP | cold Chrome stack wins |

Headers/TLS are **not** imported (Chrome rebuilds them). Budget `--max-sec` (default 25); hang kills spawned Chrome, exit 3.

## Prerequisites

- Built binary: `zig-out/bin/velora` (with `source_secure` cookie restore fix)
- `../velora-run/.venv-cookies` + `browser-cookie3`
- Chrome profile cookies:  
  `~/Library/Application Support/Google/Chrome/Profile 45/Cookies`  
  Override: `VELORA_CHROME_COOKIE_DB=/path/to/Cookies`

## Related knowledge

- `knowledge/bugs/2026-07-16-cookies-json-source-secure-https-drop.md`
- `knowledge/captcha/detection/google-search-investigation-journey.md`
- `knowledge/captcha/detection/2026-07-16-google-search-chrome150-header-order.md`

## Deep analysis (cold Chrome vs Velora)

See **[ANALYSIS-cold-chrome-vs-velora.md](./ANALYSIS-cold-chrome-vs-velora.md)**.

## P1 TLS/QUIC vs Profile velora56

See **[P1-TLS-QUIC-vs-VELORA56.md](./P1-TLS-QUIC-vs-VELORA56.md)** — what matches chrome146, what blocks JA4/ECH parity, and vendor next steps.

Key point: **fresh Chrome hop-1 also has Cookie=0** but still SERPs (often h3 + X-Client-Data). Mature cookies are a *trust bypass* for Velora, not proof that Google requires Profile 45. Cold Velora demotion is server-side tier after hop-1 signals (h2 vs h3, TLS chrome146, brands, missing X-Client-Data, …).

## Notes for discussion

- If both lanes fail SERP, check jar export (NID length ~700+ for mature `.google.com`) and that cookies attach on hop-1 (`cookieBytes` ≫ 0).
- If hop-1 headers match but tier differs, prefer Layer 0 (session cookies) over wire hygiene for *operations*; prefer cold-path wire R&D for *correctness*.
- `runs/*` is gitignored except `.gitkeep` — commit scripts/docs only.
