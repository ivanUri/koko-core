# Cookies.json restore drops all HTTPS cookies (`source_secure` default)

## Summary

Loading a mature Chrome cookie jar into Koko (`Cookies.json`) appeared to succeed (`Cookie.loadFromFile count=N`) but **hop-1 document navigations to `https://` sent zero cookies**. Only cookies set live via `Set-Cookie` during the session (e.g. short `AEC`) appeared on later hops. Google Search stayed on the low-trust bootstrap/`sei`/`sg_ss`/`/sorry` path despite a Profile 45 jar that historically unlocked SERP.

## Root cause

`Cookie.originBindingMatches` requires `cookie.source_secure == URL.isSecureOrigin(target)`.

`Cookie` defaults `source_secure: bool = false`. `cookies.loadFromFile` never set `source_secure` / `source_port` when hydrating from JSON, so every restored cookie failed the HTTPS binding check.

CDP `Network.setCookies` already sets `source_secure` from `param.url` — only the file restore path was wrong.

## Fix

In `src/runtime/cookies.zig` `loadFromFile`, set:

- `source_secure = true`
- `source_port = 443`

for restored entries (Chrome profile cookies are HTTPS-origin).

## Verify

```bash
# Export Profile 45 → jar
.venv-cookies/bin/python scripts/export-chrome-live-cookies.py \
  --cookie-file "$HOME/Library/Application Support/Google/Chrome/Profile 45/Cookies" \
  --profile chrome-local-huys-macbook-pro

# Wire: hop-1 cookieBytes >> 0, names include SID/NID/SAPISID
# Page: SERP (#rso), htmlLen ~300–400KB, no knitsail/sorry
```

After fix: hop-1 `cookieBytes≈2376`, single-hop SERP `htmlLen≈397072`.

## Related

- Layer 0 session trust (google-search-investigation-journey.md)
- Not IP: same host Chrome guest SERP OK; cold Koko jar-with-bug still sorry
