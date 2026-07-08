# WPT Cookie Suite — testdriver, parsing, secure origins, and advanced semantics

> **Date:** 2026-07-08 · **Area:** `Cookie.zig`, WPT `/cookies/` · **Status:** Core green; SameSite/nav harness gaps remain

## Summary

Velora’s cookie jar went from mass `0/N` failures to passing most parsing and attribute suites after fixing a **testdriver blocker** (`window.webdriver`), hardening **RFC6265bis parsing**, and implementing **secure-origin**, **schemeful same-site**, and **origin-bound** semantics. Eight parallel workstreams covered testdriver, name/value/encoding, path/size, attributes, ordering/detached documents, secure/prefix rules, SameSite CDP crashes, and CHIPS/third-party basics.

The bottom line: **cookie core is production-ready** for real sites; remaining WPT gaps are mostly SameSite navigation, popup harnesses, CHIPS edge cases, and batch-runner instability—not fundamental jar bugs.

---

## Problem

Early July 2026 batch runs showed **49/79** cookie test files failing, many at **0/N** before any assertion ran.

| Symptom cluster | Typical cause |
|-----------------|---------------|
| `0/N` on name/value/attributes | `test_driver.delete_all_cookies()` threw — `window.webdriver` missing from V8 snapshot |
| `0/0` + CDP JSON error | Duplicate `Cookie` header in `Network.requestWillBeSent` |
| Partial secure/prefix | `wss://` not treated as secure; WebSocket handshake dropped `Set-Cookie` |
| SameSite iframe/form `0/0` | Harness + incomplete cross-site enforcement (after CDP fix) |
| `navigated-away.html` `0/1` | Detached `contentDocument` still read parent frame cookies |

---

## Root Cause

### 1. Testdriver / snapshot gap

`wpt/resources/testdriver-vendor.js` calls `window.webdriver.deleteAllCookies()`. `WebDriver.deleteAllCookies` existed in Zig but **`Window.webdriver` was skipped** in `Snapshot.zig` (`wpt_only`) and **`WebDriver` was not in `PageJsApis`**, so the accessor returned `undefined` in every page context.

### 2. Parser vs browser laxity

WPT expects browser behavior stricter than RFC6265 prose in places: combined **4096-octet budget** (ignoring `=`), **CTL rejection** (tab allowed), **UTF-8 allowed**, **HTTP Set-Cookie sanitization** (NUL/LF in name → space, in value → truncate), and **nameless cookie** edge cases.

### 3. CDP duplicate Cookie

With curl-impersonate, `params.headers` could contain multiple `Cookie` lines while `writeCdpRequestHeadersObject` also appended jar cookies — `jsontext` rejected duplicate JSON keys → **0/0** harness crash on img/samesite tests.

### 4. Secure / WSS / prefix

`Secure` cookies on `http://` pages must be rejected. `wss://` must count as a secure origin for `Set-Cookie` and attachment. `__Host-Http-` / `__Http-` prefix rules require HTTP-only `Set-Cookie` paths.

### 5. Advanced semantics

Schemeful same-site (`http` vs `https` cross-site), origin port binding, third-party blocking, and partial CHIPS (`Partitioned` attribute) were missing for origin-bound and schemeful WPT batches.

### 6. Detached document cookies

After iframe navigation, saved `contentDocument` references must not read/write the live jar — Velora fell back to incumbent frame context via `Context.fromIsolate`.

---

## Investigation

Parallel WPT batches on `:9222` with logs in `code-check/tmp/wpt-cookies-*.txt` (since cleaned). Key experiments:

| Experiment | Verdict |
|------------|---------|
| `/infrastructure/testdriver/delete_all_cookies.html` | Pass 2/2 after snapshot rebuild |
| Individual `name.html` with stable velora | 45/45 |
| `img.https.html` before/after CDP dedupe | 0/0 crash → 2/12 pass |
| `wpt-batch-cookies.sh` with restarts | Unreliable 0/0 / SIGSEGV — infrastructure noise |

**Probe discipline:** one velora process, `scripts/wpt-run.sh` per file, rebuild snapshot after API surface changes (`make build-v8-snapshot && make build`).

---

## Solution

| Layer | Files | What changed |
|-------|-------|--------------|
| Testdriver | `Window.zig`, `bridge.zig` | Expose `window.webdriver`; register `WebDriver` in `PageJsApis`; rebuild snapshot |
| Parse / size | `Cookie.zig` | CTL/UTF-8, nameless cookies, `sanitizeHttpSetCookie`, `parseMaxAge`, size budget |
| Attributes | `Cookie.zig` | `validateAttributeSection`, path-length sort in `forRequest` |
| CDP | `network.zig` | Merge duplicate request headers case-insensitively |
| Secure / WSS | `Cookie.zig`, `URL.zig`, `WebSocket.zig`, `HttpClient.zig` | `isSecureOrigin`, native WS poll, handshake `Set-Cookie`, port relaxation for secure cookies |
| Detached doc | `Document.zig`, `HTMLDocument.zig`, `Frame.zig` | `activeBrowsingContext()`; `swapActiveDocument()` on navigate |
| Advanced | `Cookie.zig`, `storage.zig` | Schemeful same-site, origin binding, 3P block, partial CHIPS |

### Verified pass highlights

| Suite | Result |
|-------|--------|
| name / value / encoding | 45/45, 66/66, 28/28, 6/6 |
| path | 17/17 |
| attributes (parsing) | 521/522 |
| secure | 6/6 |
| prefix `__Host-Http` / `__Http` | 7/7 each |
| domain, prefix basic, samesite-none | already green |

---

## Lessons Learned

1. **Unblock harness first** — `0/N` often means setup threw, not logic wrong.
2. **Never trust batch scripts** that `kill` velora between files; port races produce false `0/0`.
3. **Snapshot changes need explicit rebuild** — new window APIs are invisible until `snapshot.bin` regenerates.
4. **CDP JSON is strict** — duplicate header keys crash wptrunner before subtests register.
5. **Document.cookie uses document context**, not incumbent JS frame — critical for navigated-away semantics.

---

## References

- WPT: `/cookies/`, `/infrastructure/testdriver/delete_all_cookies.html`
- Core: `src/core/webapi/storage/Cookie.zig`, `src/core/webapi/HTMLDocument.zig`, `src/protocols/cdp/domains/network.zig`
- Runner: `scripts/wpt-run.sh`

---

## Related Knowledge

- [`2026-07-workers-wpt-suite.md`](2026-07-workers-wpt-suite.md) — loopback same-site + CDP Cookie dedupe (workers)
- [`2026-07-04-url-wpt-suite.md`](2026-07-04-url-wpt-suite.md) — URL/searchParams WPT batch