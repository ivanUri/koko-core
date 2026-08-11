# Protocols, Adapters & Public API — bản đồ chi tiết

> Tầng `Protocols -> Adapters -> Public API` trong kiến trúc tổng. Đây là nơi engine (`src/core/` + `src/runtime/`) được "lộ ra ngoài" cho người dùng/AI agent dùng thật: CDP, MCP, CLI, server. Viết dựa trên đọc trực tiếp source + chạy `--help` thật.

## 1. `src/protocols/cdp/` — Chrome DevTools Protocol

File gốc: `CDP.zig` (dispatch chính), `Node.zig`, `AXNode.zig` (accessibility tree node), `EmulationState.zig` (trạng thái emulate — viewport, geolocation...), `id.zig` (sinh id CDP), `testing.zig`.

**21 domain đã cài đặt** trong `domains/` (mỗi file = 1 CDP domain, đúng tên chuẩn CDP spec):

| Domain | Ý nghĩa |
|---|---|
| `accessibility.zig` | Cây accessibility (AX tree) |
| `audits.zig` | CDP Audits domain (kiểm tra vấn đề trang) |
| `browser.zig` | Điều khiển browser-level (đóng, version...) |
| `css.zig` | CSSOM qua CDP (inspect/sửa style) |
| `dom.zig` | Thao tác DOM qua CDP (querySelector, getOuterHTML...) |
| `emulation.zig` | Giả lập viewport/device/geolocation/timezone |
| `fetch.zig` | Chặn/sửa request (CDP Fetch domain — request interception) |
| `input.zig` | Gửi input giả lập (mouse/keyboard) qua CDP |
| `inspector.zig` | Inspector domain cơ bản |
| `log.zig` | CDP Log domain (console/network log entries) |
| `network.zig` | Theo dõi/điều khiển network qua CDP |
| `page.zig` | Điều hướng, lifecycle event (`Page.navigate`, `Page.loadEventFired`...) — đã đọc trực tiếp: xử lý `initialFrameNavigation` reason, khớp với log `"frame : navigate"` |
| `performance.zig` | Số liệu performance |
| `runtime.zig` | Thực thi JS qua CDP (`Runtime.evaluate`, `Runtime.callFunctionOn`) — nối với `src/core/js/Inspector.zig` |
| `security.zig` | Trạng thái bảo mật (TLS...) |
| `storage.zig` | Cookie/storage qua CDP |
| `target.zig` | Quản lý target/tab (đa phiên — multi-session) |
| `koko.zig` | **Domain tuỳ biến riêng của Koko** (không thuộc chuẩn CDP) — mở rộng ngoài spec Chrome, đáng xem khi cần tính năng Koko-specific không có trong Playwright/Puppeteer chuẩn |

**Kiến trúc dispatch** (theo cách các domain thường được tổ chức trong codebase dạng này): 1 lệnh CDP JSON tới qua WebSocket → `CDP.zig` parse `{id, method: "Domain.method", params}` → tra bảng domain → gọi hàm Zig tương ứng trong `domains/<domain>.zig` → domain đó thao tác trực tiếp lên `src/core/browser/*` (Frame/Session/Page) hoặc `src/core/js/Inspector.zig` (cho Runtime domain) → trả JSON response/event ngược lại qua WebSocket. `src/adapters/server/Server.zig` là nơi socket CDP thật được accept.

## 2. `src/protocols/mcp/` — Model Context Protocol

5 file: `Server.zig`, `protocol.zig`, `resources.zig`, `router.zig`, `tools.zig`.

- Chạy qua **subcommand `koko mcp`** — theo `--help`: *"Starts an MCP (Model Context Protocol) server over stdio"* — tức là **transport là stdio, KHÔNG phải HTTP/WebSocket** như CDP (`koko serve`). Đây là điểm khác biệt quan trọng: MCP dùng cho tích hợp trực tiếp với client hỗ trợ MCP (qua stdin/stdout), CDP dùng cho tích hợp kiểu Playwright/Puppeteer (qua WebSocket).
- `tools.zig` định nghĩa các "tool" MCP expose ra cho AI agent gọi (kiểu `goto`, `click`, `screenshot`...). `resources.zig` — tài nguyên MCP (nội dung trang, danh sách tab...). `router.zig` — định tuyến request MCP method → handler. `protocol.zig` — kiểu message MCP (JSON-RPC-based theo chuẩn MCP).
- `mcp` command dùng chung phần lớn cờ với `fetch`/`serve` (cookie, robots, block-private-networks, proxy, http-timeout...) — xem bảng cờ mục 5.
- Liên quan bug đã ghi nhận: `knowledge/bugs/2026-07-15-mcp-goto-runner-deferred-parse.md` — tool `goto` của MCP từng gặp vấn đề với parse trì hoãn trong `Runner`.

## 3. `src/adapters/cli/` — CLI

- **`main.zig`** (319 dòng) — entry point thật (`pub fn main()` → `run()`). Trình tự: cấp phát `Config` trên **heap** (bắt buộc — comment giải thích: `Config` từng bị stack-allocate gây "torn reads" trên `profile.policies` do worker thread curl đọc `app.config` song song với main thread chạy `network.run()`, gây segfault trong `PolicyRegistry.policyEnabled` — bài học ownership/threading thật) → `Config.parseArgsInPlace()` → switch theo `config.mode`:
  - `.help` → in usage, thoát.
  - `.version` → in version, thoát.
  - `.profile` → gọi `profile_cmd.run()` (xem `runtime/profile_cmd.zig`).
  - `.serve` → tạo `Server`, `app.network.run()` (blocking, chạy tới khi bị signal dừng).
  - `.fetch` → set up `FetchOpts` từ toàn bộ cờ CLI, chạy fetch 1 lần rồi thoát.
  - `.mcp` → (không show trong đoạn đã đọc nhưng xác nhận qua `--help` là 1 mode riêng, transport stdio).
  - Cài `SigHandler` **trước mọi thread khác được tạo** (comment nhấn mạnh thứ tự này bắt buộc) — bắt SIGINT/SIGTERM để gọi `Network.stop`/`Server.shutdown` cho graceful shutdown.
  - `app.telemetry.record(.{.run = {}})` — mọi lần chạy đều được ghi nhận telemetry.
- **`cli.zig`** — chỉ 3 dòng, re-export `Builder` từ `src/support/cli.zig` (parser CLI dùng chung, không phải logic riêng của app).
- **`Sighandler.zig`** (154 dòng) — cài đặt signal handler thật, có `.on(callback, args)` để đăng ký nhiều handler dọn dẹp (network stop, server shutdown) chạy khi nhận tín hiệu.

## 4. `src/adapters/server/Server.zig` (699 dòng) — `koko serve`

Khởi tạo bằng `Server.init(app, address)`, lắng nghe WebSocket tại `--host`/`--port` (mặc định `127.0.0.1:9222` — đúng cổng chuẩn CDP mà Chrome/Playwright dùng, để tương thích client hiện có). Có `--advertise-host` (host báo trong response `/json/version` — hữu ích khi `--host 0.0.0.0`), `--cdp-max-connections` (mặc định 16), `--cdp-max-pending-connections` (mặc định 128, hàng đợi accept). `server.deinit()`/`Server.shutdown` được đăng ký vào `SigHandler`.

## 5. Bảng cờ CLI đầy đủ (từ `--help` thật, đã chạy trực tiếp)

### Cờ chung `fetch` (một số cũng dùng lại ở `serve`/`mcp`)

| Cờ | Mặc định | Ý nghĩa |
|---|---|---|
| `--dump <html\|markdown\|semantic_tree\|semantic_tree_text>` | không dump | Kiểu output in ra stdout |
| `--strip-mode <js,ui,css,full>` | — | Loại bỏ nhóm tag khỏi dump |
| `--with-base` | false | Thêm `<base>` tag vào dump |
| `--with-frames` | false | Gồm cả nội dung iframe trong dump |
| `--wait-ms` | 5000 | Thời gian chờ (ms), ghi đè mọi `--wait-*` khác nếu set |
| `--wait-until <load\|domcontentloaded\|networkidle\|domstable\|done>` | `done` | Điều kiện dừng chờ — **đây chính là biến quyết định `met` trong `Runner._tick()`** |
| `--wait-selector` | — | Chờ selector CSS xuất hiện |
| `--wait-script` / `--wait-script-file` | — | Chờ biểu thức JS trả truthy |
| `--click-selector` / `--click-offset-x` (mặc định 28) / `--click-offset-y` (mặc định giữa dọc) | — | Click sau khi điều kiện wait thoả |
| `--terminate-ms` | không terminate | Deadline cứng, ép dừng JS (khác `--wait-ms` chỉ dừng chờ) |
| `--cookie` | — | File JSON cookie nạp vào (override profile seed) |
| `--cookie-jar` | — | *(deprecated)* Đường dẫn cookie jar runtime, ưu tiên dùng profile dir |
| `--insecure-disable-tls-host-verification` | false | Tắt xác minh host TLS (nguy hiểm, chỉ dùng khi hiểu rủi ro) |
| `--obey-robots` | false | Tôn trọng robots.txt |
| `--block-private-networks` | false | Chặn request tới IP nội bộ sau DNS resolve |
| `--block-cidrs` | — | Thêm CIDR chặn (prefix `-` để miễn trừ) |
| `--google-chrome-transport` | false | Route navigation `google.com/search` qua Chrome thật (né gap fingerprint QUIC của curl) |
| `--http-proxy` | — | Proxy HTTP (hỗ trợ `user:pass@`) |
| `--proxy-bearer-token` | — | Bearer token cho proxy |
| `--http-max-concurrent` | 10 | Số request đồng thời tối đa |
| `--http-max-host-open` | 4 | Số connection mở tối đa/host:port |
| `--http-connect-timeout` | 0 (không timeout) | Timeout thiết lập connection (ms) |
| `--http-timeout` | 10000 | Timeout hoàn tất transfer (ms) |
| `--http-max-response-size` | không giới hạn | Giới hạn kích thước response |
| `--ws-max-concurrent` | 8 | Số WebSocket đồng thời tối đa |
| `--log-level` | `info` | `debug\|info\|warn\|error\|fatal` |
| `--log-format` | `pretty` | `pretty\|logfmt` |
| `--log-filter-scopes` | — | Lọc bớt scope quá ồn (vd `http`, `unknown_prop`, `event`) |
| `--log-dir [PATH]` | `logs` nếu bật | Ghi log có cấu trúc vào `PATH/<run-id>/`, tạo sẵn `js/`, `core/`, `network/`, `protocol/`, `system/` — **công cụ debug quan trọng nhất đã dùng thực tế để lần ra bug treo event loop** |
| `--log-run-id` | tự sinh | Đặt tên thư mục run cụ thể |
| `--log-no-combined` | false | Không ghi `combined.log` |
| `--log-cdp-trace` | false | Ghi raw CDP wire message vào `protocol/cdp-wire.log` |
| `--log-level-js` / `--log-level-core` / `--log-level-network` / `--log-level-protocol` / `--log-level-system` | — | Override log level riêng từng channel |
| `--user-data-dir` | OS app data dir (macOS: `~/Library/Application Support/koko`) | Thư mục gốc kiểu Chrome user-data-dir |
| `--browser-profile` | `Default` | Tên thư mục profile trong user-data-dir — lần đầu dùng sẽ tạo `Preferences.json` trỏ tới 1 fingerprint id (vd `chrome-macos-sonoma`) |
| `--browser-profile-pool` | — | Danh sách profile, chọn ngẫu nhiên khi không set `--browser-profile` |
| `--fingerprint-folder` | — | Bundle fingerprint tự chứa (dùng cho SaaS/offline) |
| `--user-agent` | — | Ghi đè User-Agent hoàn toàn — **cấm chứa "Mozilla"** trừ khi dùng antidetect profile (tránh giả mạo browser khác 1 cách ngây thơ); vẫn gửi `Sec-Ch-Ua`; không dùng chung được với `--user-agent-suffix` |
| `--user-agent-suffix` | — | Thêm hậu tố vào User-Agent mặc định `Koko/X.Y` |
| `--web-bot-auth-key-file` / `--web-bot-auth-keyid` / `--web-bot-auth-domain` | — | Web Bot Auth (Ed25519 key, JWK thumbprint, domain) — xem `runtime/network/WebBotAuth.zig` |
| `--http-cache-dir` | `Cache/` dưới user-data-dir | Thư mục cache HTTP |
| `--storage-engine <none\|sqlite>` | `none` | Backend lưu trữ bền (IndexedDB...) |
| `--storage-sqlite-path` | — | Đường dẫn file sqlite (hoặc `:memory:`) |

### `profile` command

```
koko profile list
koko profile create --name <id> [--fingerprint <fingerprint-id>]
koko profile delete --name <id>
koko profile import-cookies [--name <id>] --from <cookies.json>
koko profile export --name <id> [--to <bundle-dir>]
koko profile import --name <id> --from <bundle-dir>
```

### `serve` command — cờ riêng (ngoài cờ chung ở trên)

| Cờ | Mặc định | Ý nghĩa |
|---|---|---|
| `--host` | `127.0.0.1` | Host CDP server |
| `--port` | `9222` | Port CDP server |
| `--advertise-host` | = `--host` | Host báo trong `/json/version` |
| `--cdp-max-connections` | 16 | Số kết nối CDP đồng thời tối đa |
| `--cdp-max-pending-connections` | 128 | Hàng đợi accept tối đa |

### `mcp` command

Không cờ riêng — dùng lại tập cờ chung (cookie, robots, block-private-networks, proxy, http-timeout...). Chạy `koko mcp` (không tham số) → server MCP qua stdio.

## 6. `src/public/` — API "công khai" (thực tế phần lớn là stub, xem lưu ý quan trọng bên dưới)

4 file, đối chiếu trực tiếp với bản tương ứng trong `src/core/browser/`:

| File | Dòng | Thực trạng (đã đọc trực tiếp) |
|---|---|---|
| `public/Frame.zig` | 37 | **Stub** — bọc `internal_frame: *core.browser.Frame`, nhưng `goto()`, `content()`, `evalString()` đều là thân hàm rỗng (`_ = url; _ = self;`, trả `""`) |
| `public/Browser.zig` | 28 | Chưa đọc chi tiết, kích thước tương tự → nhiều khả năng cũng ở dạng khung/stub |
| `public/Session.zig` | 27 | tương tự |
| `public/Runtime.zig` | 50 | tương tự, hơi lớn hơn 1 chút |

**Kết luận quan trọng**: đừng lầm tưởng `src/public/` là nơi Koko thực sự expose ra ngoài. API thật mà end-user/SDK dùng là **CDP** (`koko serve` → `@koko/sdk` ở repo `koko-sdk` riêng, kết nối `Browser.connect("http://127.0.0.1:9222")` theo README) và **CLI** (`koko fetch`). `src/public/` trông giống một lớp facade Rust/Zig-embedding dự định cho tương lai (dùng trực tiếp Koko như thư viện Zig) nhưng **chưa được hiện thực hoá** tại thời điểm khảo sát này — nếu cần kiểm tra lại tình trạng này, đọc trực tiếp cả 4 file (chỉ tốn vài giây, tổng 142 dòng).

## 7. `src/support/` — tiện ích dùng chung

| File | Vai trò |
|---|---|
| `log.zig` | Hệ thống logging có cấu trúc trung tâm — mọi `log.info/debug/warn/err/fatal(.scope, "msg", .{fields})` trong toàn bộ codebase đi qua đây. Hỗ trợ format `pretty` (màu ANSI, như thấy trong mọi log INFO mặc định) và `logfmt`. `log.initSink()` bật ghi file có cấu trúc khi `--log-dir` được set, tách theo scope (`js/`, `core/`, `network/`, `protocol/`, `system/`) + `combined.log` + `errors.log`. **Công cụ chẩn đoán số 1** khi debug hành vi runtime — luôn thử `--log-level debug --log-dir <path>` trước khi đoán mò đọc code. |
| `log_sink.zig` | Backend ghi file thật cho `log.zig` (mở file, buffer, flush). |
| `crash_handler.zig` | Panic handler tuỳ biến, ghi đè handler mặc định Zig — in `"Koko has crashed..."` + `reason` + `OS`/`mode`/`version` + cố gắng dump stack trace (thường thất bại vì debug info bị strip — xem `build-and-dependencies.md` mục Zig 0.15.2 bug). Gọi `std.posix.abort()` cuối cùng → tiến trình nhận SIGABRT, **bắt được bằng `lldb`**. |
| `assert.zig` | Assertion helper dùng xuyên suốt engine (`assert(condition, "context", .{...})` — khác `std.debug.assert` chuẩn, có thể có thông điệp cấu trúc riêng). |
| `cli.zig` | `Builder` — framework parse CLI args dùng chung (không riêng cho koko, generic). |
| `datetime.zig` | Tiện ích ngày giờ. |
| `id.zig` | Sinh ID (request id, frame id...). |
| `rc.zig` | Reference-counting helper (có thể dùng cho shared ownership 1 số resource). |
| `slab.zig` | Slab allocator (cấp phát theo khối cố định — hiệu năng cho object có vòng đời ngắn/đồng dạng). |
| `string.zig` | Tiện ích chuỗi dùng chung. |
| `sys/idna.zig` | IDNA (Internationalized Domain Names) — encode/decode domain Unicode. |
| `sys/libcrypto.zig`, `sys/libcurl.zig` | FFI binding trực tiếp sang OpenSSL/libcrypto và libcurl. |
| `sys/zlib_stream.zig` | Binding zlib (giải nén gzip/deflate response HTTP). |

## 8. `src/testing/` — hạ tầng test

`TestHTTPServer.zig`, `TestWSServer.zig` — server HTTP/WebSocket giả lập chạy trong test, cho phép test deterministic không phụ thuộc mạng thật (đúng yêu cầu trong `AGENTS.md`: *"Add a minimal deterministic regression test without third-party network dependencies"*). `test_runner.zig`, `testing.zig` — hạ tầng chạy test chung.

## 9. `src/data/`

`public_suffix_list.zig` — danh sách public suffix (dùng để xác định "domain gốc" đúng chuẩn, vd phân biệt `example.co.uk` với `co.uk`) — cần cho cookie domain matching chuẩn xác. `public_suffix_list_gen.go` — **generator viết bằng Go** (build system có yêu cầu Go toolchain ẩn ở đây, ngoài Zig/Rust/Node đã liệt kê trong README — chỉ cần khi regenerate danh sách, không cần cho build thường).

## 10. Bảng tra cứu nhanh

| Cần làm gì | Xem file |
|---|---|
| Thêm/sửa 1 CDP method | `src/protocols/cdp/domains/<domain>.zig` |
| Thêm 1 MCP tool cho AI agent | `src/protocols/mcp/tools.zig` |
| MCP dùng transport gì | stdio, xem `mcp` command trong `--help`, khởi động ở `main.zig` |
| CLI thêm 1 cờ mới | `src/runtime/Config.zig` (định nghĩa + parse) rồi nối vào `main.zig`/`cli.zig` |
| Server CDP nhận kết nối ra sao | `src/adapters/server/Server.zig` |
| Signal handling / graceful shutdown | `src/adapters/cli/Sighandler.zig` |
| Vì sao stack trace panic vô dụng | `src/support/crash_handler.zig` + `knowledge/codebase-map/pitfalls-and-invariants.md` mục 6 |
| Bật log chi tiết để debug | Cờ `--log-level debug --log-dir <path>`, backend ở `src/support/log.zig`/`log_sink.zig` |
| API công khai thật sự nằm ở đâu | CDP (`protocols/cdp/`) hoặc CLI (`adapters/cli/`) — KHÔNG PHẢI `src/public/` (mục 6) |
| Domain gốc / cookie theo public suffix | `src/data/public_suffix_list.zig` |
| Test không phụ thuộc mạng thật | `src/testing/TestHTTPServer.zig`/`TestWSServer.zig` |
