#include <stdio.h>
#include <string.h>
#include <curl/curl.h>

static size_t write_cb(char *ptr, size_t size, size_t nmemb, void *userdata) {
    size_t total = size * nmemb;
    fwrite(ptr, 1, total, stdout);
    return total;
}

int main(int argc, char **argv) {
    const char *params = argc > 1 ? argv[1] : NULL;
    CURL *easy = curl_easy_init();
    if (!easy) return 1;

    curl_easy_setopt(easy, CURLOPT_URL, "https://quic.browserleaks.com/");
    curl_easy_setopt(easy, CURLOPT_HTTP_VERSION, (long)CURL_HTTP_VERSION_3);
    curl_easy_setopt(easy, CURLOPT_WRITEFUNCTION, write_cb);
    curl_easy_setopt(easy, CURLOPT_TIMEOUT, 15L);
    curl_easy_setopt(easy, CURLOPT_ACCEPT_ENCODING, "");

    curl_easy_impersonate(easy, "chrome146", 1);
    curl_easy_setopt(easy, CURLOPT_TLS_GREASE, 1L);

    if (params) {
        curl_easy_setopt(easy, CURLOPT_QUIC_TRANSPORT_PARAMETERS, params);
    }

    CURLcode rc = curl_easy_perform(easy);
    if (rc != CURLE_OK) {
        fprintf(stderr, "curl error: %s\n", curl_easy_strerror(rc));
    }

    long http_version = 0;
    curl_easy_getinfo(easy, CURLINFO_HTTP_VERSION, &http_version);
    fprintf(stderr, "http_version=%ld\n", http_version);

    curl_easy_cleanup(easy);
    return rc == CURLE_OK ? 0 : 2;
}