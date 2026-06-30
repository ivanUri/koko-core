# Benchmark — đánh giá hiệu năng Velora

Folder này **chỉ chứa file `.md`** — báo cáo đánh giá benchmark, không có JSON/log/binary.

## Chạy lại toàn bộ (~20 test)

```bash
npm run bench:suite
# tuỳ chọn profile:
npm run bench:suite -- --profile chrome-local-huys-macbook-pro
```

Script: `scripts/benchmark-suite.mjs` (JSON tạm ghi vào `code-check/tmp/`, không vào đây).

## Cấu trúc

| ID | File | Nội dung |
|----|------|----------|
| 01–02 | `01-startup-*.md` | Cold start Velora vs Chromium |
| 03–06 | `*-nav-*.md` | Navigation fixtures (`velora-test/`) |
| 07–09 | `*-js-*.md` | JS workloads (dom-query, json-loop, hash-loop) |
| 10–18 | `*-sdk-*.md` | SDK LP / agent APIs |
| 19 | `19-crawl-wikipedia-mini.md` | Crawl 5 trang Wikipedia |
| 20 | `20-summary.md` | Tổng hợp + khuyến nghị |

## Đọc kết quả

- **Ratio V/C < 1.0** → Velora nhanh hơn Playwright Chromium
- **Ratio V/C > 1.0** → Velora chậm hơn
- 🟢 / 🟡 / 🔴 trong từng file = đánh giá nhanh

Snapshot mới nhất: xem `20-summary.md`.