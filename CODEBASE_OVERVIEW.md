# Velora — Tổng quan mã nguồn (dành cho AI đọc trước khi code)

> **Mục đích của file này**: cho một phiên AI coding mới bức tranh đầy đủ về dự án Velora TRƯỚC KHI phải đọc lại hàng trăm file source. Đọc file này trước, sau đó mới đọc code cụ thể liên quan tới việc đang làm. Các file chi tiết hơn nằm ở `knowledge/codebase-map/` (tiếng Việt, dành riêng cho AI — khác với `knowledge/` gốc là ghi chép kỹ thuật tiếng Anh dành cho blog/kỹ sư, xem mục 7).
>
> Viết dựa trên đọc trực tiếp source code + 1 phiên debug thực tế (điều tra vì sao export `grok.com` không vượt qua Cloudflare Turnstile — đã lần ra tận gốc rễ trong engine, xem `knowledge/codebase-map/pitfalls-and-invariants.md` mục 7).

## 1. Velora là gì

Browser engine headless viết **từ đầu bằng Zig** (không dựa trên Chromium), tối ưu cho automation/AI agent thay vì duyệt web tương tác của con người. Mục tiêu: nhẹ hơn, khởi động nhanh hơn, kiểm soát lifecycle chính xác hơn so với việc nhúng Chromium đầy đủ (qua Playwright/Puppeteer). Xem `README.md` để biết định vị sản phẩm; xem `AGENTS.md` để biết **luật kỹ thuật bắt buộc** khi sửa code (tóm tắt lại ở mục 6 bên dưới).

**Quy mô**: ~178,600 dòng Zig trong `src/`. 109 commit tính tới thời điểm khảo sát.

## 2. Kiến trúc 5 tầng

```
Core Engine  ->  Runtime  ->  Protocols  ->  Adapters  ->  Public API
src/core/        src/runtime/  src/protocols/  src/adapters/  src/public/
```

| Tầng | Thư mục | Vai trò | Tài liệu chi tiết |
|---|---|---|---|
| Core Engine | `src/core/` (401 file) | DOM, HTML parser (html5ever/Rust), JS binding (V8), toàn bộ Web API (305 file trong `webapi/`) | [`knowledge/codebase-map/core-engine.md`](knowledge/codebase-map/core-engine.md) |
| Runtime | `src/runtime/` (71 file) | Network stack (curl), ArenaPool, realm lifecycle, fingerprint/anti-detect profile (28 file), storage, telemetry | [`knowledge/codebase-map/runtime-and-network.md`](knowledge/codebase-map/runtime-and-network.md) |
| Protocols | `src/protocols/` (30 file) | CDP (21 domain) + MCP (stdio) | [`knowledge/codebase-map/protocols-and-adapters.md`](knowledge/codebase-map/protocols-and-adapters.md) |
| Adapters | `src/adapters/` (4 file) | CLI (`main.zig`) + Server (`velora serve`) | cùng file trên |
| Public API | `src/public/` (4 file) | **Lưu ý: hiện phần lớn là stub chưa hiện thực** — xem mục 5 | cùng file trên |

Ngoài ra: `src/support/` (tiện ích chung: logging, crash handler, FFI libcurl/libcrypto/zlib), `src/testing/` (server HTTP/WS giả cho test deterministic), `src/data/` (public suffix list).

**Build system**: `build.zig` (52KB/1262 dòng) — xem [`knowledge/codebase-map/build-and-dependencies.md`](knowledge/codebase-map/build-and-dependencies.md) cho mọi chi tiết (cờ `-D...`, cách link V8/curl-impersonate/html5ever-Rust/WebRTC/nghttp2, cảnh báo `.zig-cache` có thể phình 20GB+).

## 3. Bắt đầu nhanh

```bash
zig build                                   # build Debug, ra ./zig-out/bin/velora
./zig-out/bin/velora fetch --dump html https://example.com/
./zig-out/bin/velora serve --host 127.0.0.1 --port 9222   # CDP server
./zig-out/bin/velora mcp                    # MCP server qua stdio
```

Cờ CLI đầy đủ (tất cả `--wait-*`, `--http-*`, `--browser-profile`, `--log-*`...) đã được liệt kê nguyên văn từ `--help` thật trong `protocols-and-adapters.md` mục 5 — **không đoán cờ, tra bảng đó**.

**Debug hành vi runtime**: luôn thử trước
```bash
./zig-out/bin/velora fetch --dump html --log-level debug --log-dir /tmp/vlog <url>
```
rồi soát `network/all.log` (đối chiếu `"intercept start"`/`"intercept done"` với `"release connection"` theo url) và `core/all.log` (đếm `microtask.checkpoint.*` bất thường = dấu hiệu busy-spin). Đây là kỹ thuật đã thực sự dùng để tìm ra root cause 1 bug treo event loop — xem case study đầy đủ trong `pitfalls-and-invariants.md` mục 7.

## 4. Luồng dữ liệu 1 lần `fetch` (tóm tắt để định hướng đọc code)

```
main.zig → Config.parseArgsInPlace() → App.init()
  → Frame.navigate(url) → HttpClient.request() (qua Network/curl)
  → response → Parser.parse() (html5ever) → DOM tree
  → ScriptManagerBase chạy <script> theo thứ tự static/defer/async
  → JS thực thi trong V8 realm, gọi ngược DOM/Web API qua js/TaggedOpaque + webapi/
  → Runner._tick() lặp tới khi điều kiện --wait-until thoả (hoặc hết --wait-ms)
  → dump ra stdout theo --dump
```

Mọi mắt xích trên đều đã được đọc trực tiếp và ghi chú chi tiết trong `core-engine.md`/`runtime-and-network.md`.

## 5. 3 điều dễ hiểu lầm nhất (đọc kỹ trước khi giả định)

1. **`src/public/` KHÔNG phải API thật đang dùng.** Đã đọc trực tiếp `public/Frame.zig`: `goto()`/`content()`/`evalString()` là thân hàm rỗng. API thật là **CDP** (`velora serve`, dùng bởi SDK TypeScript ở repo riêng `velora-sdk`) và **CLI** (`velora fetch`).
2. **"Không pass qua Cloudflare/anti-bot" không nhất thiết là bị phát hiện.** Trong ca thật đã điều tra, nguyên nhân là engine tự treo (busy-spin CPU) do 1 transfer HTTP không bao giờ được tầng curl đánh dấu hoàn tất — không liên quan gì tới fingerprint. Luôn kiểm tra network log trước khi kết luận "bị chặn".
3. **Panic không có stack trace hữu ích là chuyện BÌNH THƯỜNG của repo này**, không phải máy bạn cấu hình sai — `build.zig` cố ý luôn strip debug info kể cả ở Debug build (workaround 1 bug thật của Zig 0.15.2 compiler). Dùng `lldb -o run -o "thread backtrace all"` thay vì trông chờ vào output panic mặc định.

## 6. Luật bắt buộc khi sửa code (tóm tắt `AGENTS.md` — đọc file gốc để đủ chi tiết)

- **Cấm** vá theo hostname/site cụ thể. Nếu fix không giải thích được mà không nhắc tên site → dừng lại, tìm invariant tổng quát của web platform đang bị vi phạm.
- Sửa đúng component sở hữu invariant (DOM/CSS/navigation/event loop/networking/JS realm/serialization) — không vá bù ở lớp CLI/exporter/lifecycle sau.
- Mọi arena/response/handle/listener/task phải có đúng 1 chủ sở hữu, đúng 1 đường giải phóng, an toàn qua mọi nhánh (success/error/cancel/navigate/timeout/shutdown/stale-realm).
- Quy trình: reproduce + ghi bằng chứng → phát biểu invariant vi phạm → soát mọi caller liên quan → fix nhỏ nhất áp dụng chung → test tối thiểu không phụ thuộc mạng thật → test hẹp rồi rộng → site thật chỉ để kiểm tra tích hợp cuối, không encode vào logic production.
- Còn có `.clinerules` (luật tương tự, ngắn gọn hơn, dùng bởi Cline) và `.grok/rules/` (luật cho Grok agent, gồm cả rule "sau mỗi fix quan trọng phải viết note vào `knowledge/`") — cả 3 bộ luật (`AGENTS.md`, `.clinerules`, `.grok/rules/`) đồng nhất về tinh thần: root-cause only, không hardcode/spoof, không vá riêng từng site.
- Xem thêm `knowledge/codebase-map/pitfalls-and-invariants.md` cho danh sách cạm bẫy cụ thể đã gặp thật (ArenaPool leak, cancel-on-nav race, busy-spin event loop, Zig compiler bug...).

## 7. Hai kho tài liệu khác nhau — đừng nhầm

- **`knowledge/codebase-map/`** (thư mục này tạo ra) — tiếng Việt, mục đích DUY NHẤT là giúp AI đọc code nhanh hơn, cập nhật khi kiến trúc thay đổi lớn. Không cần theo chuẩn "blog-length".
- **`knowledge/`** (gốc, đã tồn tại từ trước) — sổ tay kỹ thuật tiếng Anh CHÍNH THỨC của dự án, mỗi bài hướng tới trở thành 1 bài blog public (900–2500 từ tuỳ loại, xem `knowledge/README.md`). Chia theo: `architecture/` (quyết định kiến trúc), `bugs/` (post-mortem bug + WPT suite), `fingerprint/` (từng vector chống fingerprint), `captcha/` (reCAPTCHA/hCaptcha/Turnstile/Arkose), `automation/`, `performance/`, `research/`, `blog/`. **Trước khi báo "phát hiện bug mới", luôn grep tên hiện tượng trong `knowledge/bugs/` và `knowledge/architecture/` trước** — rất nhiều bug tưởng mới đã có người gặp và ghi chép.
- Quy tắc riêng của `knowledge/`: viết bằng tiếng Anh, note = bản nháp chính thức (viết đủ dài ngay từ đầu, không viết ngắn rồi mở rộng sau), luôn có mục "Related Knowledge" liên kết bài khác.

## 8. Bản đồ thư mục gốc (ngoài `src/`)

| Thư mục/file | Nội dung |
|---|---|
| `knowledge/` | Sổ tay kỹ thuật (mục 7) |
| `knowledge/codebase-map/` | 4 file chi tiết bổ sung cho file này: `core-engine.md`, `runtime-and-network.md`, `protocols-and-adapters.md`, `build-and-dependencies.md`, `pitfalls-and-invariants.md` |
| `docs/` | Tài liệu public ngắn: `homebrew.md` (publish qua Homebrew tap), `tls-impersonate.md`, `curl-impersonate-fork.md` |
| `scripts/` | Script Node.js phụ trợ: `export-single-site.js`/`export-site.js` (export 1 hoặc nhiều URL ra HTML tĩnh qua `velora fetch`), `capture-fingerprint.js`, `convert-kameleo.js` (chuyển đổi fingerprint bundle định dạng Kameleo), `profile-bundle.mjs`, các `.sh`/`urls-*.txt` phục vụ test hàng loạt |
| `browser/` | `fingerprints/` (bundle fingerprint theo profile, vd `huynew`, `velora`, `kameleo-*`) và `policies/` (policy JSON, vd `google-search.json` + `plugins/`) — dữ liệu cấu hình runtime, không phải code |
| `exports/`, `export-logs/` | Output thật từ `velora fetch` (HTML đã export + log tương ứng) — dữ liệu làm việc, không phải nguồn |
| `decoded_view/` | JSON đã giải mã từ 1 profile bundle cụ thể (`ic`, `local`, `opts`, `profile_bin`) — có vẻ là output debug/kiểm tra bundle |
| `dist/` | Bản build đã đóng gói sẵn (`velora-1.0.1-darwin-arm64`, `velora-1.0.2-darwin-arm64` + tarball) |
| `velora-test/` | File HTML test cố định nhỏ (`dom-heavy.html`, `js-compute.html`, `minimal.html`, `mixed.html`) — dùng cho benchmark/test local, không phụ thuộc mạng |
| `packaging/` | Công thức Homebrew (`packaging/homebrew/velora.rb`) và tài nguyên đóng gói khác |
| `vendor/` | Dependency vendor hoá: `curl-impersonate` (+ patches), `v8-wrapper`, `libidn2`, `stb_image_write`, `canvas_text_macos.c` |
| `.velora-cache/` | Cache bootstrap V8 + depot_tools (nhiều GB — **không xoá tuỳ tiện**, xem `build-and-dependencies.md`) |
| `.zig-cache/` | Cache biên dịch Zig (có thể phình 20GB+ — **an toàn để `rm -rf`**, sẽ tự tạo lại) |
| `.github/workflows/release.yml` | CI: publish GitHub Release khi push tag `v*` hoặc chạy thủ công (`workflow_dispatch`) |
| `.grok/` | Cấu hình + rules cho Grok CLI agent (`config.toml`, `hooks/`, `rules/`) |
| `.clinerules` | Luật kỹ thuật cho Cline (tinh thần giống `AGENTS.md`, ngắn gọn hơn) |
| `AGENTS.md` | **Luật kỹ thuật bắt buộc** — đọc trước khi sửa code (mục 6) |
| `package.json` | Chỉ có 2 dependency Node (`playwright`, `ws`) + script `export-site` — phần Node CHỈ phục vụ script phụ trợ (`scripts/`), không phải phần chạy chính của Velora (đó là binary Zig) |

## 9. Khi nào cần cập nhật lại các file này

Cập nhật `knowledge/codebase-map/*.md` khi: thêm/xoá 1 subsystem lớn, đổi kiến trúc event loop/lifecycle, đổi cờ CLI đáng kể, đổi dependency build lớn. KHÔNG cần cập nhật cho mỗi bug fix nhỏ — bug fix nhỏ nên vào `knowledge/bugs/` theo quy tắc ở mục 7.
