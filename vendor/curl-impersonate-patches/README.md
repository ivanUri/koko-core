# Koko curl-impersonate H3/QUIC patches (v2.0.0rc3)

Apply after first `make build` so ExternalProject sources exist:

```bash
./scripts/apply-koko-curl-patches.sh
# or full pipeline:
./scripts/build-vendor-curl.sh
```

## Files

| Patch | Target (v2.0.0rc3 tree) | Purpose |
|-------|-------------------------|---------|
| `koko-h3-fingerprint-nghttp3.patch` | `nghttp3` | GREASE + Chrome PRIORITY_UPDATE (type `0x0f0700`) submit APIs |
| `koko-h3-fingerprint-curl.patch` | curl `lib/vquic/cf-ngtcp2.c` | Inject frames after H3 control stream bind |
| `koko-quic-chrome150-hello.patch` | curl `lib/vtls/openssl.c` | Omit SCT/status_request on **QUIC** ClientHello |
| `koko-quic-http3-sig-prefs.patch` | curl `lib/vtls/openssl.c` | Prefer `HTTP3_SIG_HASH_ALGS` on QUIC (no ML-DSA on h3) |

**Note:** Upstream renamed `curl_ngtcp2.c` → `cf-ngtcp2.c`. The curl H3 frame patch must target `cf-ngtcp2.c` (manual port done 2026-07-17 in `.koko-cache`).

## Verify

```bash
vendor/curl-impersonate/curl_chrome150 --http3 -sS https://quic.browserleaks.com/fp | jq '{ja4,h3_text}'
# expect ja4 q13d0311h3_… and h3_text containing 984832
```
