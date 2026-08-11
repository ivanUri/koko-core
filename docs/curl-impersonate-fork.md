# curl-impersonate (external fork)

Koko **không** embed full source trong repo. Runtime artifacts live in `vendor/curl-impersonate/`.

**Current vendor:** [lexiforest/curl-impersonate](https://github.com/lexiforest/curl-impersonate) **v2.0.0rc3** (`curl 8.21.0-IMPERSONATE`, BoringSSL with ML-DSA / Chrome 150 sig algs).

Optional build-from-source fork (patches / H3): **https://github.com/ivanUri/curl-impersonate**

`vendor/curl-impersonate/` (macOS) chứa **dylib + headers + CLI wrappers** — đủ cho `zig build` trên macOS.

**Linux:** download prebuilt ELF (không ghi đè macOS dylib):

```bash
./scripts/fetch-linux-curl-impersonate.sh
# → vendor/curl-impersonate/linux/libcurl-impersonate.so + .a + include/
zig build -Dprebuilt_v8_path=v8/libc_v8.a
export LD_LIBRARY_PATH="$PWD/vendor/curl-impersonate/linux:$LD_LIBRARY_PATH"
```

`build.zig` chọn artifact theo OS: macOS dùng dylib root vendor; Linux dùng `vendor/curl-impersonate/linux/`. Hai cây độc lập — có macOS `.a` không bật impersonate trên Linux.

**Chrome 150:** không có preset upstream; Koko dùng `chrome146` + `--signature-hashes mldsa44:mldsa65:mldsa87:…` (`curl_chrome150` wrapper, `TransportProfile.chrome150`).

## Build vendor (một lệnh)

```bash
./scripts/build-vendor-curl.sh
```

Script sẽ:

1. Clone/update vào `.koko-cache/curl-impersonate/` (gitignored)
2. `make build` + apply patch H3 Koko
3. Copy artifacts → `vendor/curl-impersonate/`

## Thủ công

```bash
./scripts/fetch-curl-impersonate.sh
cd .koko-cache/curl-impersonate
make build && ./scripts/apply-koko-patches.sh && make build
cd ../..
CURL_IMPERSONATE_ROOT=.koko-cache/curl-impersonate ./scripts/vendor-sync-curl.sh
```

## Custom path

```bash
export CURL_IMPERSONATE_ROOT=~/dev/curl-impersonate
export CURL_IMPERSONATE_REPO=git@github-ivan:ivanUri/curl-impersonate.git
./scripts/build-vendor-curl.sh
```

## Sync upstream (trong clone riêng)

```bash
cd .koko-cache/curl-impersonate
git remote add upstream https://github.com/lexiforest/curl-impersonate.git 2>/dev/null || true
git fetch upstream --tags
git merge v2.0.0a6   # ví dụ tag mới
./scripts/apply-koko-patches.sh
make build
```