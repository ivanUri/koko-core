# 20. Tổng hợp benchmark suite

> **Ngày:** 2026-06-30 · **Host:** Huys-MacBook-Pro.local · **Git:** `f17a19d9`

## Tổng quan

Chạy **20** báo cáo benchmark (folder `benchmark/` chỉ chứa .md).

### Microbench vs Chromium

| Nhóm | Geomean ratio (V/C) | Đánh giá |
|------|--------------------:|----------|
| Navigation | **3.49x** | 🔴 Velora chậm hơn |
| JS workloads | **6.53x** | 🔴 Velora chậm hơn |
| Startup | **2.28x** | 🔴 Velora chậm hơn |

### SDK / Agent

- LP extraction APIs: ✅ pass
- Crawl mini: 5/5 trang

### Khuyến nghị

1. **Scale crawl** — `npm run example:crawl` hoặc `bench:crawl:wikipedia` khi cần so sánh Chromium.
2. **Agent** — dùng `page.detectForms` + `NodeHandle` thay vì CSS thuần.
3. **Đo lại** sau mỗi thay đổi engine lớn; lưu snapshot mới vào `benchmark/`.

## Danh sách file

- [`01-startup-velora.md`](./01-startup-velora.md)
- [`02-startup-chromium.md`](./02-startup-chromium.md)
- [`06-nav-dom-heavy.md`](./06-nav-dom-heavy.md)
- [`05-nav-js-compute.md`](./05-nav-js-compute.md)
- [`03-nav-minimal.md`](./03-nav-minimal.md)
- [`04-nav-mixed.md`](./04-nav-mixed.md)
- [`07-js-dom-query.md`](./07-js-dom-query.md)
- [`08-js-json-loop.md`](./08-js-json-loop.md)
- [`09-js-hash-loop.md`](./09-js-hash-loop.md)
- [`10-sdk-goto-done.md`](./10-sdk-goto-done.md)
- [`11-sdk-markdown.md`](./11-sdk-markdown.md)
- [`12-sdk-semantic-tree.md`](./12-sdk-semantic-tree.md)
- [`13-sdk-structured-data.md`](./13-sdk-structured-data.md)
- [`14-sdk-links.md`](./14-sdk-links.md)
- [`15-sdk-extract-wiki.md`](./15-sdk-extract-wiki.md)
- [`16-sdk-detect-forms.md`](./16-sdk-detect-forms.md)
- [`17-sdk-interactive-elements.md`](./17-sdk-interactive-elements.md)
- [`18-sdk-agent-fill.md`](./18-sdk-agent-fill.md)
- [`19-crawl-wikipedia-mini.md`](./19-crawl-wikipedia-mini.md)
- [`20-summary.md`](./20-summary.md)
