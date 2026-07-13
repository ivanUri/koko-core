# Amazon.com empty shell: AWS WAF challenge + HMAC importKey stub

## Summary

`https://www.amazon.com` often returned HTTP **202** with header `x-amzn-waf-action: challenge` and a ~2KB HTML shell that loads AWS WAF `challenge.js`. Site-stability reported **empty title** and **html too small (1995 < 10000)**. Process stayed alive; the page never progressed past the challenge.

## Root causes

### 1. AWS WAF Bot Control (primary product failure)

When challenged, the document is:

```html
<script>window.gokuProps = { key, iv, context };</script>
<script src="…token.awswaf.com/…/challenge.js"></script>
<script>
  AwsWafIntegration.getToken().then(() => location.reload(true));
</script>
```

Telemetry endpoints (`inputs`, `report`) returned 200, but `getToken()` resolved with `null`, no `aws-waf-token` cookie, and no reload. Observed unhandled rejections: `TypeError: invalid argument` and (before the fix) `InvalidAccessError` from Web Crypto.

Challenge payload (decoded `inputs` body) used `challenge_type: "NetworkBandwidth"`.

### 2. `crypto.subtle.importKey` for HMAC was a stub

`SubtleCrypto.importKey` only implemented raw **AES-GCM**. Every other algorithm (including `{ name: "HMAC", hash: "SHA-256" }`) went through `importKeyStub`, which created a key with `_type = .aes` and random material.

Then `subtle.sign("HMAC", key, data)` hit:

```zig
switch (key._type) {
    .hmac => HMAC.sign(...),
    else => InvalidAccessError, // stubbed AES key here
}
```

AWS WAF challenge signing therefore failed.

### 3. Intermittent alternate path

Sometimes Amazon serves HTTP 200 + soft interstitial (`POST /_sec/verify?provider=interstitial`) then a real homepage (~850KB, title `Amazon.com. Spend less. Smile more.`). That path does not need WAF token crypto. First-load results are therefore **flaky** depending on which gate Amazon chooses.

## Fix

Implemented real **HMAC raw import** and routed it from `importKey`:

- `src/core/webapi/crypto/HMAC.zig` — `importKey(...)` builds `_type = .hmac` with digest + usages
- `src/core/webapi/SubtleCrypto.zig` — `.hmac_key_gen => HMAC.importKey(...)`

Site-stability probe improvements:

- Per-site `settleMs` (Amazon: 3000)
- Poll extract until `title` non-empty and `htmlBytes >= minHtmlBytes` (or deadline)

## Verification

```bash
# HMAC sign after import (was InvalidAccessError)
# → ok, 32-byte MAC

# When Amazon returns 200 interstitial path:
node code-check/site-stability/run.mjs --site amazon --repeats 1 --max-sec 30
# PASS — ~850KB, "Amazon.com. Spend less. Smile more."

# When Amazon returns 202 AWS WAF:
# still may stick at 1995B shell (remaining TypeError: invalid argument /
# NetworkBandwidth challenge incomplete — further work)
```

## Follow-up fix: `Response.arrayBuffer` / `text` hang

`StreamConsumer` (used by `Response.arrayBuffer` / `text` / `json` on streamed fetch bodies) attached a Zig `then` callback typed as:

```zig
const ReadData = struct { done: bool, value: js.Value };
```

When the stream finished, Zig resolved `{ done: true, value: .empty }` → JS `{ done: true, value: undefined }`. Converting back to non-optional `js.Value` failed → the then-callback threw → the **outer** body promise was never settled → hang. That broke AWS WAF `NetworkBandwidth` body reads and plain `fetch().arrayBuffer()`.

Fix: `value: ?js.Value = null` and treat missing/undefined as empty chunk; set `_body_used` on the stream `arrayBuffer` path.

```bash
# after fix
fetch().text()        → textLen: 559
fetch().arrayBuffer() → len: 559
node run.mjs --site amazon --repeats 1  # 3/3 PASS ~850KB
```

## Residual

- **Re-navigate** in one CDP session can still drop the websocket on some sites — separate lifecycle issue.
- AES **generateKey** still stubbed (import/encrypt work).

## Related

- Fetch / script teardown UAFs on SPA navigations (NYT) — separate lifecycle work.
- Web Crypto AES-GCM encrypt/import already implemented; AES **generateKey** still stubbed.
