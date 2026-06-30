# curl-impersonate (external fork)

Velora **không** embed `curl-impersonate/` trong repo. Build lấy từ fork:

**https://github.com/ivanUri/curl-impersonate** (forked from lexiforest/curl-impersonate)

`vendor/curl-impersonate/` chỉ chứa **dylib + headers** sau build — đủ cho `zig build`.

## Build vendor (một lệnh)

```bash
./scripts/build-vendor-curl.sh
```

Script sẽ:

1. Clone/update vào `.velora-cache/curl-impersonate/` (gitignored)
2. `make build` + apply patch H3 Velora
3. Copy artifacts → `vendor/curl-impersonate/`

## Thủ công

```bash
./scripts/fetch-curl-impersonate.sh
cd .velora-cache/curl-impersonate
make build && ./scripts/apply-velora-patches.sh && make build
cd ../..
CURL_IMPERSONATE_ROOT=.velora-cache/curl-impersonate ./scripts/vendor-sync-curl.sh
```

## Custom path

```bash
export CURL_IMPERSONATE_ROOT=~/dev/curl-impersonate
export CURL_IMPERSONATE_REPO=git@github-ivan:ivanUri/curl-impersonate.git
./scripts/build-vendor-curl.sh
```

## Sync upstream (trong clone riêng)

```bash
cd .velora-cache/curl-impersonate
git remote add upstream https://github.com/lexiforest/curl-impersonate.git 2>/dev/null || true
git fetch upstream --tags
git merge v2.0.0a6   # ví dụ tag mới
./scripts/apply-velora-patches.sh
make build
```