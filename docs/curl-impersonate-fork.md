# curl-impersonate fork (đúng cách)

Velora dùng fork **GitHub thật** của [lexiforest/curl-impersonate](https://github.com/lexiforest/curl-impersonate) — **không** tải zip, **không** tạo repo trống mới.

| Sai | Đúng |
|-----|------|
| Tạo repo trống `ivanUri/curl-impersonate` → push code | Bấm **Fork** trên trang lexiforest/curl-impersonate |
| Clone lwthiker/curl-impersonate (gốc cũ) | Fork từ **lexiforest** (bản cập nhật) |

Fork thật giữ liên kết upstream trên GitHub, lịch sử git, và có thể mở PR ngược lexiforest.

## Fork (live)

**https://github.com/ivanUri/curl-impersonate** — forked from lexiforest/curl-impersonate.

| Branch / tag | Nội dung |
|--------------|----------|
| `main` | Trùng upstream `v2.0.0a5` |
| `velora/main` | + patch H3 fingerprint Velora |
| `v2.0.0a5-velora.1` | Tag pin cho Velora submodule |

## Bước 2 — Clone fork (không clone lexiforest trực tiếp)

```bash
git clone git@github-ivan:ivanUri/curl-impersonate.git
cd curl-impersonate
git remote add upstream https://github.com/lexiforest/curl-impersonate.git
git fetch upstream --tags
git checkout v2.0.0a5
git switch -c velora/main
```

## Bước 3 — Thêm patch Velora

Copy từ Velora repo (hoặc cherry-pick commit đã chuẩn bị sẵn tại `~/Desktop/curl-impersonate`):

```bash
# Nếu đã có bản local ~/Desktop/curl-impersonate với commit velora:
cd ~/Desktop/curl-impersonate
git remote set-url origin git@github-ivan:ivanUri/curl-impersonate.git
git fetch origin
git push -u origin velora/main
git push origin v2.0.0a5-velora.1
```

Hoặc copy thủ công:

- `patches/velora/*.patch`
- `VELORA.md`
- `scripts/apply-velora-patches.sh`

```bash
git add patches/velora VELORA.md scripts/apply-velora-patches.sh
git commit -m "velora: H3 fingerprint patches"
git tag v2.0.0a5-velora.1
git push origin velora/main --tags
```

## Velora monorepo (submodule — đã gắn)

```ini
# .gitmodules
[submodule "curl-impersonate"]
    path = curl-impersonate
    url = git@github-ivan:ivanUri/curl-impersonate.git
    branch = velora/main
```

Clone Velora:

```bash
git clone --recurse-submodules git@github-ivan:ivanUri/velora.git
```

`vendor/curl-impersonate/` vẫn là dylib build — sync bằng `scripts/vendor-sync-curl.sh`.

## Sync upstream sau này

```bash
cd curl-impersonate
git fetch upstream --tags
git checkout velora/main
git merge v2.0.0a6    # tag mới từ lexiforest
./scripts/apply-velora-patches.sh
make build
```

## Remote chuẩn

```text
origin   → git@github-ivan:ivanUri/curl-impersonate.git   (fork của bạn)
upstream → https://github.com/lexiforest/curl-impersonate.git
```