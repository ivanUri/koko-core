// Stub for curl_ws_start_frame when linking libcurl-impersonate (no WS start API).
#include <curl/curl.h>

CURLcode curl_ws_start_frame(CURL *curl, unsigned int flags, curl_off_t frame_len) {
    (void)curl;
    (void)flags;
    (void)frame_len;
    return CURLE_NOT_BUILT_IN;
}