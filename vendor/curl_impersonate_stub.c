// Stub curl-impersonate entry point for stock libcurl Linux builds.
// Real fingerprinting requires vendor/curl-impersonate (macOS dylib/.a in this repo).

#include <curl/curl.h>

CURLcode curl_easy_impersonate(CURL *easy, const char *target, int default_headers) {
    (void)easy;
    (void)target;
    (void)default_headers;
    // No-op: request still works with default TLS fingerprint.
    return CURLE_OK;
}
