#!/usr/bin/env bash
# Re-apply Velora Chrome-150 fingerprint patches to an existing
# .velora-cache/curl-impersonate tree (after clean rebuild of deps).
# Then: rebuild curl + vendor-sync.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CURL_SRC="$ROOT/.velora-cache/curl-impersonate/build/deps/src/curl"
NGHTTP3_SRC="$ROOT/.velora-cache/curl-impersonate/build/deps/src/nghttp3"
INSTALL_INC="$ROOT/.velora-cache/curl-impersonate/build/deps/install/include/nghttp3"

if [[ ! -f "$CURL_SRC/lib/vtls/openssl.c" ]]; then
  echo "Missing curl source. Run: ./scripts/build-vendor-curl.sh (pass 1) first" >&2
  exit 1
fi

python3 - <<PY
from pathlib import Path
import re

root = Path(r"""$ROOT""")
curl = root / ".velora-cache/curl-impersonate/build/deps/src/curl"
ng = root / ".velora-cache/curl-impersonate/build/deps/src/nghttp3"


# --- openssl.c: QUIC omit SCT/status; HTTP3 sig prefs ---
op = curl / "lib/vtls/openssl.c"
t = op.read_text()
if "peer->transport != TRNSPRT_QUIC" not in t or "tls_signed_cert_timestamps &&" not in t:
    a = """  /* Enable TLS extension 18, signed_certificate_timestamp. */
  if(data->set.tls_signed_cert_timestamps)
    SSL_CTX_enable_signed_cert_timestamps(octx->ssl_ctx);

  /* Enable TLS extension 5, status_request. */
  if(data->set.tls_status_request)
    SSL_CTX_enable_ocsp_stapling(octx->ssl_ctx);"""
    b = """  /* SCT + status_request only on TCP (Chrome omits on QUIC ClientHello). */
  if(data->set.tls_signed_cert_timestamps &&
     peer->transport != TRNSPRT_QUIC)
    SSL_CTX_enable_signed_cert_timestamps(octx->ssl_ctx);

  if(data->set.tls_status_request &&
     peer->transport != TRNSPRT_QUIC)
    SSL_CTX_enable_ocsp_stapling(octx->ssl_ctx);"""
    if a in t:
        t = t.replace(a, b, 1)
        print("openssl: SCT/QUIC guard applied")
    else:
        print("openssl: SCT block missing/already different")
else:
    print("openssl: SCT guard ok")

if "STRING_HTTP3_SIG_HASH_ALGS" not in t or "peer->transport == TRNSPRT_QUIC" not in t:
    c = """    /* curl-impersonate: Set the signature algorithms (TLS extension 13). */
    const char *signature_algorithms = conn_config->signature_algorithms;
    if(signature_algorithms) {
      CURLcode result = parse_sig_algs(data, signature_algorithms, algs,
                                       &nalgs);"""
    d = """    /* Prefer HTTP3 sig list on QUIC (Chrome: no ML-DSA on QUIC). */
    const char *signature_algorithms = conn_config->signature_algorithms;
    if(peer->transport == TRNSPRT_QUIC &&
       data->set.str[STRING_HTTP3_SIG_HASH_ALGS]) {
      signature_algorithms = data->set.str[STRING_HTTP3_SIG_HASH_ALGS];
    }
    if(signature_algorithms) {
      CURLcode result = parse_sig_algs(data, signature_algorithms, algs,
                                       &nalgs);"""
    if c in t:
        t = t.replace(c, d, 1)
        print("openssl: HTTP3 sig prefs applied")
    else:
        print("openssl: sig prefs block missing")
else:
    print("openssl: HTTP3 sig prefs ok")
op.write_text(t)

# --- nghttp3 APIs ---
h = ng / "lib/includes/nghttp3/nghttp3.h"
ht = h.read_text()
if "nghttp3_conn_submit_grease" not in ht:
    idx = ht.find("nghttp3_conn_submit_settings")
    end = ht.find(");", idx)
    end = ht.find("\n", end)
    insert = """

NGHTTP3_EXTERN int nghttp3_conn_submit_grease(nghttp3_conn *conn,
                                              int64_t frame_type);

NGHTTP3_EXTERN int nghttp3_conn_submit_chrome_priority_update(
  nghttp3_conn *conn, int64_t frame_type, int64_t pri_elem_id,
  const uint8_t *data, size_t datalen);
"""
    ht = ht[: end + 1] + insert + ht[end + 1 :]
    h.write_text(ht)
    print("nghttp3.h: APIs added")
else:
    print("nghttp3.h: ok")

cpath = ng / "lib/nghttp3_conn.c"
ct = cpath.read_text()
if "nghttp3_conn_submit_grease" not in ct:
    m = re.search(r"int nghttp3_conn_submit_settings\(.*?\n\}\n", ct, re.S)
    if m:
        impl = """
int nghttp3_conn_submit_grease(nghttp3_conn *conn, int64_t frame_type) {
  nghttp3_frame fr;
  if (!conn->tx.ctrl) return NGHTTP3_ERR_INVALID_STATE;
  memset(&fr, 0, sizeof(fr));
  fr.hd.type = frame_type;
  return nghttp3_stream_frq_add(conn->tx.ctrl, &fr);
}

int nghttp3_conn_submit_chrome_priority_update(nghttp3_conn *conn,
                                               int64_t frame_type,
                                               int64_t pri_elem_id,
                                               const uint8_t *data,
                                               size_t datalen) {
  nghttp3_frame fr;
  uint8_t *buf = NULL;
  if (!conn->tx.ctrl) return NGHTTP3_ERR_INVALID_STATE;
  if (datalen) {
    buf = nghttp3_mem_malloc(conn->mem, datalen);
    if (buf == NULL) return NGHTTP3_ERR_NOMEM;
    memcpy(buf, data, datalen);
  }
  memset(&fr, 0, sizeof(fr));
  fr.priority_update = (nghttp3_frame_priority_update){
    .type = frame_type,
    .pri_elem_id = pri_elem_id,
    .data = buf,
    .datalen = datalen,
  };
  return nghttp3_stream_frq_add(conn->tx.ctrl, &fr);
}

"""
        cpath.write_text(ct[: m.end()] + impl + ct[m.end() :])
        print("nghttp3_conn.c: APIs added")
    else:
        print("nghttp3_conn.c: submit_settings not found")
else:
    print("nghttp3_conn.c: ok")

# stream fill_outq default case — only if missing
spath = ng / "lib/nghttp3_stream.c"
st = spath.read_text()
if "nghttp3_stream_write_empty_frame" not in st:
    print("nghttp3_stream.c: needs manual stream patch (see knowledge note)")
else:
    print("nghttp3_stream.c: ok")

# --- cf-ngtcp2.c GREASE after init_ctrls ---
cf = curl / "lib/vquic/cf-ngtcp2.c"
ct = cf.read_text()
if "submit_chrome_priority_update" not in ct:
    marker = "  else\n    curlx_free(h3iv);\n\n  return Curl_cf_ngtcp2_h3_init_ctrls(ctx, data);\n}"
    insert = """  else
    curlx_free(h3iv);

  {
    CURLcode result = Curl_cf_ngtcp2_h3_init_ctrls(ctx, data);
    if(result)
      return result;
  }

  /* Chrome 150 H3: GREASE + PRIORITY_UPDATE 0x0f0700 after control stream bind */
  {
    unsigned char rndbuf[sizeof(uint32_t)];
    CURLcode rnd_result = Curl_rand(data, rndbuf, sizeof(rndbuf));
    if(!rnd_result) {
      uint32_t rnd;
      int64_t grease_type;
      static const uint8_t chrome_pri[] = "u=0, i";
      memcpy(&rnd, rndbuf, sizeof(rnd));
      grease_type = (int64_t)((UINT64_C(0x1f) * (uint64_t)rnd) + UINT64_C(0x21));
      rc = nghttp3_conn_submit_grease(ctx->h3conn, grease_type);
      if(rc) {
        failf(data, "error submitting HTTP/3 GREASE frame: %s",
              nghttp3_strerror(rc));
        return CURLE_QUIC_CONNECT_ERROR;
      }
      rc = nghttp3_conn_submit_chrome_priority_update(
        ctx->h3conn, (int64_t)0x0f0700, 0,
        chrome_pri, sizeof(chrome_pri) - 1);
      if(rc) {
        failf(data, "error submitting HTTP/3 PRIORITY_UPDATE frame: %s",
              nghttp3_strerror(rc));
        return CURLE_QUIC_CONNECT_ERROR;
      }
    }
  }

  return CURLE_OK;
}"""
    if marker in ct:
        cf.write_text(ct.replace(marker, insert, 1))
        print("cf-ngtcp2.c: GREASE applied")
    else:
        print("cf-ngtcp2.c: marker missing (maybe already patched)")
else:
    print("cf-ngtcp2.c: ok")
PY

# install nghttp3 headers/libs
if [[ -d "$ROOT/.velora-cache/curl-impersonate/build/deps/build/nghttp3" ]]; then
  (cd "$ROOT/.velora-cache/curl-impersonate/build/deps/build/nghttp3" && cmake --build . -j"$(sysctl -n hw.ncpu 2>/dev/null || echo 4)" && cmake --install .)
fi

echo "==> Rebuild curl + sync"
(cd "$ROOT/.velora-cache/curl-impersonate/build/deps/build/curl" && \
  rm -f lib/CMakeFiles/libcurl_shared.dir/vquic/cf-ngtcp2.c.o \
        lib/CMakeFiles/libcurl_shared.dir/vtls/openssl.c.o \
        lib/libcurl-impersonate.4.8.0.dylib src/curl-impersonate && \
  ninja)
"$ROOT/scripts/vendor-sync-curl.sh"
cp -f "$ROOT/.velora-cache/curl-impersonate/build/deps/build/curl/src/curl-impersonate" \
  "$ROOT/vendor/curl-impersonate/curl-impersonate" 2>/dev/null || true
echo "Done. Smoke:"
echo "  vendor/curl-impersonate/curl_chrome150 -sS https://tls.browserleaks.com/json | jq .ja4"
echo "  vendor/curl-impersonate/curl_chrome150 --http3 -sSL https://quic.browserleaks.com/fp | jq .ja4"
