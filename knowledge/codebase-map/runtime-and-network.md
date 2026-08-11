# Runtime & Network — bản đồ chi tiết

> Phần này thuộc tầng `Runtime` trong kiến trúc `Core Engine -> Runtime -> Protocols -> Adapters -> Public API`.
> Thư mục: `src/runtime/` (71 file .zig). Viết dựa trên việc đọc trực tiếp source trong phiên debug thực tế (không phải suy đoán từ tên file).

## 1. Tổng quan

`src/runtime/` là tầng "dịch vụ" ngồi giữa engine lõi (`src/core/`) và các protocol/adapter bên ngoài. Nó sở hữu:
- Vòng đời ứng dụng (`App.zig`) và cấu hình (`Config.zig`, 1061 dòng — file cấu hình lớn nhất repo)
- Network stack thực sự (curl-based, đa lớp) — `network/`
- Cấp phát bộ nhớ theo arena có pool + leak-detector — `ArenaPool.zig`
- Vòng đời "realm" (ngữ cảnh JS/document) và cơ chế huỷ-khi-navigate — `RealmLifecycleKernel.zig`
- Fingerprint/anti-detection profile system — `profile/` (28 file — subsystem lớn thứ 2 sau webapi)
- Storage (cookie, localStorage, sqlite) — `storage/`
- Telemetry — `telemetry/`
- Profile/session persistence trên đĩa — `profile_session.zig`, `session_persist.zig`, `cookies.zig`

## 2. `App.zig` — app instance gốc

`App` là struct gốc giữ: `network: Network`, `config: *const Config`, `storage: Storage`, `platform: Platform` (V8 platform), `snapshot: Snapshot` (V8 heap snapshot đã build sẵn — xem `zig build snapshot_creator`), `telemetry`, `arena_pool: ArenaPool`, `app_dir_path` (thư mục dữ liệu ứng dụng, macOS: `~/Library/Application Support/koko/`).

`App.init()` khởi tạo theo thứ tự: Platform → Snapshot.load() → Storage → Network → app dir → Telemetry → ArenaPool. `deinit()` giải phóng theo thứ tự ngược lại. Đây là điểm khởi đầu thực sự khi chạy `koko fetch`/`serve`.

## 3. `ArenaPool.zig` — nguồn gốc của bug "ArenaPool: leaked arenas detected"

**Đây là bug phổ biến nhất quan sát được trong `export-logs/` của dự án (48/62 crash log có reason này).** Đọc trực tiếp source để hiểu cơ chế:

- `ArenaPool` quản lý 4 bucket kích cỡ cố định: `tiny` (≤512B, giữ tối đa 1024 arena), `small` (≤4KB, tối đa 128), `medium` (≤16KB, tối đa 64), `large` (≤128KB, tối đa 32). Mỗi bucket là một free-list các `ArenaAllocator` được tái sử dụng (tránh cấp phát/OS mmap liên tục).
- `acquire(size_or_bucket, debug: []const u8)` lấy một arena ra khỏi free-list (hoặc tạo mới) và — **chỉ trong build Debug** — ghi nhận vào `_leak_track: StringHashMapUnmanaged(isize)` với key là chuỗi `debug` (nhãn mô tả, ví dụ `"Request.arena"`, `"Frame.srcdoc"` — mỗi call site tự đặt tên). Mỗi lần `acquire` tăng counter của nhãn đó lên 1; `release` (không đọc trong file này nhưng theo logic) phải giảm lại.
- `deinit()` (gọi khi `App` bị huỷ — tức là khi tiến trình `fetch` dọn dẹp cuối cùng) **chỉ trong Debug build**: duyệt `_leak_track`, nếu bất kỳ nhãn nào có counter ≠ 0 → `log.err(.bug, "ArenaPool leak", ...)` rồi **`@panic("ArenaPool: leaked arenas detected")`**.

**Ý nghĩa thực tiễn**: panic này KHÔNG xảy ra tại thời điểm rò rỉ thực sự — nó chỉ kích hoạt ở cuối vòng đời khi `App.deinit()` chạy, và nó chỉ là detector chạy trong Debug build (build mặc định của `zig build`/Makefile `build-dev`). Vì vậy: nếu gặp crash này, nguyên nhân gốc nằm ở MỘT nơi nào đó trước đó đã gọi `arena_pool.acquire(..., "some-label")` mà quên gọi release tương ứng trên một đường lỗi/sớm-return/panic nào đó — cần tìm theo đúng chuỗi `name=` trong log lỗi (`ArenaPool leak name=X count=N`) rồi grep `acquire(` với label `"X"` trong code để tìm call site thiếu release. Đây chính xác là loại bug mà `knowledge/bugs/2026-07-22-link-preload-arena-leak.md` và `knowledge/bugs/2026-07-09-worker-deferred-script-and-image-arena.md` đã từng vá.

## 4. `RealmLifecycleKernel.zig` — hợp đồng "cancel-on-nav"

File này (dòng 1-25 là docstring kiến trúc, đáng đọc nguyên văn) định nghĩa **hợp đồng huỷ-khi-điều-hướng** áp dụng cho MỌI công việc bất đồng bộ gắn với 1 document:

```
State = enum { initializing, active, draining, dead }
```

- `initializing`: realm đang được dựng, chưa observer nào được thấy WindowProxy/execution context/injected script.
- `active`: JS, timer, DOM mutation được phép chạy bình thường.
- `draining`: đang teardown — không được schedule macrotask mới; việc đang chạy phải tự kết thúc hoặc tự rút lui khi kiểm tra epoch.
- `dead`: V8 context đã (đang) bị huỷ — cấm tuyệt đối schedule việc mới.

Chuỗi huỷ 4 bước bắt buộc khi 1 frame điều hướng đi nơi khác (đọc nguyên văn trong docstring):
1. **Realm**: `Frame.prepareForOutgoingAbort` → `.draining`, dừng script, huỷ streaming parser, `cancelOwnedSchedulerWork()`.
2. **Network**: mọi HTTP transfer gắn với document phải set `RequestParams.attribution_frame`; `HttpClient.abortTransfersAttributedTo` sẽ huỷ chúng — thiếu gắn attribution sẽ bị log và **panic trong Debug build** (xem `ensureRequestAttribution` trong `HttpClient.zig` — đã gặp trực tiếp trong session này).
3. **Scheduler**: chỉ chạy qua `Frame.runOwnedScheduler*`/macrotask pump có gate `canRunOwnedScheduler`; khi draining/dead thì xả hàng đợi thay vì chạy.
4. **Parser**: sau mỗi lần poll CDP, phải re-check `_realm_state == .active` trước khi mutate DOM (`appendNew`, `create`...).

`TaskOwner{realm_id, epoch, document_id}` là "vé sở hữu" gắn vào mỗi công việc async (timer, microtask, fetch, MutationObserver, custom element) để phát hiện công việc "stale" (thuộc navigation cũ) và tự huỷ thay vì chạy nhầm trên DOM đã chết — đây chính là cơ chế chống UAF (use-after-free) trung tâm của toàn bộ engine. Phần lớn bug trong `knowledge/bugs/` liên quan tới race lúc renavigate (`renav-*`, `cancel-on-nav-ownership`, `realm-scheduler-suppressed-teardown`...) đều xoay quanh việc VI PHẠM hợp đồng 4 bước này ở đâu đó.

## 5. `network/` — network stack

### Kiến trúc lớp (layer chain)
`src/runtime/network/layer/` — mỗi request HTTP đi qua một chuỗi layer (giống middleware), mỗi layer đọc/ghi hoặc chặn transfer trước khi đưa cho layer kế:
- `Forward.zig` (130 dòng) — layer chuyển tiếp thẳng, chắc chắn là layer cuối chuỗi đưa request ra `Network`/curl thật.
- `CacheLayer.zig` (464 dòng) — cache HTTP theo `cache/Cache.zig` + `cache/FsCache.zig` (cache trên filesystem). Log ta từng thấy trong session debug: `$scope=cache $msg=miss reason=missing`.
- `InterceptionLayer.zig` (266 dòng) — layer "chặn/quan sát" response, dùng cho devtools-style interception. **Quan trọng**: hàm `doneCallback` ở đây log `"intercept done"` khi đã nhận đủ `content_length` bytes — đây là tín hiệu Ở TẦNG NÀY, KHÔNG PHẢI tín hiệu transfer thật sự đóng kết nối ở tầng curl bên dưới. Trong phiên debug session trước, ta phát hiện 1 request (script `api.js` từ Cloudflare Turnstile) có `"intercept done"` đầy đủ nhưng KHÔNG BAO GIỜ có `"release connection"` theo sau — nghĩa là interception layer coi là xong nhưng transfer thật (curl multi-handle) không bao giờ báo hoàn tất, khiến `http_active` kẹt > 0 mãi mãi. Đây là một class bug thật (transfer-completion không đồng bộ giữa interception layer và transport layer) — xem thêm `knowledge/codebase-map/pitfalls-and-invariants.md` mục "Treo do transfer không bao giờ release".
- `RobotsLayer.zig` (258 dòng) — tôn trọng `robots.txt` khi `--obey-robots` bật, dùng `Robots.zig`.
- `WebBotAuthLayer.zig` (46 dòng) — liên quan `WebBotAuth.zig`, có thể là cơ chế xác thực bot hợp lệ (Web Bot Auth spec).

### `Network.zig` (889 dòng) — lõi network thật
Struct `Network` giữ: `robot_store`, `web_bot_auth`, `cache`, mảng `connections: []http.Connection` dùng chung (connection pool), `ws_pool` (WebSocket riêng), `pollfds` cho `poll()` syscall thủ công, `wakeup_pipe` (pipe để đánh thức thread poll từ thread khác), `multi: ?*libcurl.CurlM` (curl multi-handle — **được tạo lười/on-demand**, comment ghi rõ "Multi is a heavy structure that can consume up to 2MB of RAM"), `submission_queue` (hàng đợi request nộp từ thread khác chờ được đưa vào multi-handle), và `callbacks` (tick callbacks, tối đa 16).

Model threading: có main thread (chạy `Network.tick`/`poll`) và các submission có thể tới từ thread khác (nộp vào `submission_queue` có mutex riêng, được "đánh thức" qua `wakeup_pipe`).

### Các file khác trong `network/`
- `http.zig` — kiểu `Connection`, `Transport` (union: `http`, có thể còn kiểu khác), khái niệm dùng chung bởi HttpClient (ở `src/core/browser/HttpClient.zig`) và Network.
- `TlsIo.zig` — I/O TLS (liên quan tới `docs/tls-impersonate.md`, vendor `curl-impersonate`).
- `IpFilter.zig` — lọc IP (dùng cho `--block-private-networks`, `--block-cidrs`).
- `Robots.zig` — parser + store cho robots.txt.
- `WebBotAuth.zig` — logic Web Bot Auth.
- `WebSocketClient.zig`, `WsConnection.zig`, `H2WsSession.zig` — WebSocket qua HTTP/1.1 và qua HTTP/2 (H2WsSession — WS over H2, tương đối hiếm gặp, đáng chú ý).
- `WireHeaderCapture.zig` — bắt header thô trên dây (phục vụ `--log-cdp-trace` hoặc fingerprint/JA3 kiểm chứng).
- `RtcCommandQueue.zig`, `RtcEventQueue.zig`, `WebRtcThread.zig` — hàng đợi lệnh/sự kiện WebRTC chạy trên **thread riêng** (`WebRtcThread`), giao tiếp với `src/core/webapi/net/rtc/IceAgent.zig` qua các queue này. Đây là lý do log `webrtc: STUN binding request sent` xuất hiện độc lập với luồng HTTP chính — WebRTC KHÔNG chạy qua `Network`/curl mà có transport UDP + thread riêng.

### Quan hệ với `src/core/browser/HttpClient.zig`
`HttpClient` (nằm bên `src/core/`, không phải `src/runtime/`) là client-facing API mà `Frame`/`ScriptManagerBase` gọi để tạo request (`request()`, `tick()`). Nó chạy trên **curl multi-handle của riêng nó** (`self.handles`), khác với `Network.multi` — cần đọc kỹ cả hai để biết chính xác quan hệ sở hữu (không giả định chúng là cùng 1 curl-multi). `HttpClient.perform()` là nơi quyết định `PerformStatus` (`normal` / `idle` / `cdp_socket`) — `idle` là tín hiệu duy nhất cho phép `Runner._tick()` ngủ thay vì spin (xem file `codebase-map/core-engine.md` mục Runner.zig để hiểu vòng lặp tick đầy đủ — đã reverse-engineer kỹ trong phiên debug thực tế trước đó).

## 6. `profile/` — hệ thống fingerprint / chống phát hiện (28 file, subsystem lớn)

Đây là phần triển khai chi tiết cho mục tiêu "trông giống trình duyệt thật" mà `knowledge/fingerprint/` và `knowledge/captcha/` mô tả ở tầng kiến trúc/nghiên cứu. Các file đáng chú ý (tên đã tự giải thích khá rõ, xác nhận qua cấu trúc thư mục):

- `Profile.zig`, `ProfileManager.zig`, `ProfileStore.zig`, `ProfileRuntime.zig`, `ProfileRotation.zig`, `ProfilePaths.zig` — quản lý "hồ sơ trình duyệt" (giống Chrome profile: cookie, localStorage, fingerprint seed cố định theo `--browser-profile <name>` — CLI flag ta dùng suốt session debug, ví dụ `huynew`). `ProfilePaths.zig` chắc chắn định nghĩa đường dẫn `~/Library/Application Support/koko/<profile>/Cookies.json`, `Local Storage/storage.json` mà ta đã thấy trong log.
- `FingerprintSeed.zig`, `FingerprintStore.zig` — seed ngẫu nhiên/cố định để fingerprint (canvas, audio, WebGL...) nhất quán giữa các lần chạy cùng 1 profile nhưng khác biệt giữa các profile.
- `AudioIntelligent.zig`, `CanvasIntelligent.zig`, `ClientRectsIntelligent.zig`, `HtmlElementVersionIntelligent.zig`, `MeasureTextIntelligent.zig`, `NavigatorKeysIntelligent.zig`, `SvgIntelligent.zig`, `WebGLIntelligent.zig`, `WindowKeysIntelligent.zig` — mỗi file là một "bộ giả lập thông minh" cho 1 vector fingerprint cụ thể (âm thanh, canvas, getClientRects, DOM version quirks, đo văn bản, navigator keys, SVG, WebGL, window keys) — tương ứng trực tiếp với các thư mục nghiên cứu `knowledge/fingerprint/{audio,canvas,webgl,...}/`.
- `NativeCanvas.zig`, `NativeBuiltinHooks.zig` — hook các hàm builtin JS/canvas ở tầng native để giả mạo nhất quán (khớp với `knowledge/bugs/2026-06-29-creepjs-*` và `2026-07-13-creepjs-maths-timing-injection.md`).
- `MathsNative.zig` — đúng là nguồn gốc của log `"js : maths native install entries=27 methods=27"` xuất hiện RẤT nhiều lần trong mọi log debug session này (mỗi lần 1 realm/context mới được tạo) — cài đặt lại 27 hàm Math native để tránh timing/side-channel fingerprinting (xem `knowledge/bugs/2026-07-13-creepjs-maths-timing-injection.md`).
- `WebGLParameters.zig` — bảng tham số WebGL giả lập theo từng "profile phần cứng".
- `ClientHints.zig`, `HeaderPlanner.zig`, `HeaderPlugins.zig`, `HttpProfile.zig`, `TransportProfile.zig` — lập kế hoạch HTTP header (User-Agent, Sec-CH-UA, Accept, thứ tự header...) và transport-level fingerprint (JA3/JA4, TLS — liên kết `docs/tls-impersonate.md` + `curl-impersonate`).
- `NavigationPlanner.zig` — có thể liên quan tới `--google-chrome-transport` (route qua Chrome thật cho Google SERP, theo `--help` CLI đã đọc).
- `AutomationScrub.zig` — được gọi trực tiếp trong `Frame.navigate()` (`AutomationScrub.applyOnce(self)`) — xoá dấu vết automation (kiểu `navigator.webdriver`) mỗi lần navigate.
- `AutomationPolicy.zig` (ở `src/runtime/` gốc, không phải trong `profile/`) — chính sách automation tổng thể.
- `PolicyRegistry.zig`, `HostEnvironment.zig`, `BrowserRoot.zig`, `Spoofing.zig` — hạ tầng đăng ký chính sách / môi trường host / gốc rễ giả lập trình duyệt.
- `plugins/ClientVariations.zig`, `plugins/XBrowser.zig` — plugin thêm header đặc thù (X-Client-Data kiểu Chrome, biến thể client).

**Đọc thêm**: mọi quyết định "giả cái gì, giả thế nào" nên tra cứu `knowledge/fingerprint/` (theo từng vector: audio/canvas/cookies/css/css-media/fonts/http/navigator/permissions/screen/timing/tls/webgl) và `knowledge/captcha/` (arkose/detection/hcaptcha/recaptcha/turnstile) TRƯỚC khi đọc code — các note đó thường giải thích "tại sao" mà code một mình không nói rõ.

## 7. `storage/` — cookie, localStorage, sqlite

- `Storage.zig` — struct tổng hợp, chắc chắn là điểm dùng chung giữa cookie jar và local storage.
- `Blackhole.zig` — có thể là backend storage "không lưu gì" (dùng cho mode ẩn danh/không profile).
- `sqlite/Sqlite.zig`, `sqlite/Pool.zig`, `sqlite/migrations.zig` — SQLite được dùng làm backend lưu trữ bền (có connection pool + migration hệ thống). Đây khớp với hạng mục "IndexedDB, lifecycle" trong commit gần nhất của repo (`c5dbba57`, `fecc9015`) — rất có thể IndexedDB (`src/core/webapi/idb.zig`) dùng sqlite làm backend lưu trữ qua lớp này.

## 8. `telemetry/`
`telemetry.zig`, `koko.zig` — thu thập số liệu vận hành (đã thấy gọi `session.browser.app.telemetry.record(.{ .navigate = .{...} })` trong `Frame.navigate()` với field `tls`, `proxy`...).

## 9. `Config.zig` (1061 dòng) — cấu hình toàn cục

File cấu hình lớn nhất repo — đây LÀ nơi ánh xạ mọi cờ CLI (`--http-timeout`, `--wait-until`, `--block-private-networks`, `--log-level`...) thành giá trị runtime. `WaitUntil` enum (`.done`, `.domcontentloaded`, `.load`, `.networkidle`) được định nghĩa ở đây — dùng trực tiếp bởi `Runner.TickOpts.until`. Khi cần biết "cờ CLI X ảnh hưởng gì tới runtime", tra `Config.zig` trước, `cli.zig` (parse) sau.

## 10. `Notification.zig`, `cookies.zig`, `profile_cmd.zig`, `profile_session.zig`, `session_persist.zig`

- `Notification.zig` — hệ thống dispatch sự kiện nội bộ dùng xuyên suốt (`session.notification.dispatch(.frame_navigate, &.{...})`, `.frame_child_frame_created`...) — cơ chế observer pattern trung tâm để các module khác (CDP domains, telemetry...) lắng nghe sự kiện browser mà không cần phụ thuộc trực tiếp.
- `cookies.zig` — parse/serialize cookie (định dạng JSON đã thấy trong `Cookies.json`).
- `profile_cmd.zig` — logic cho subcommand CLI `koko profile`.
- `profile_session.zig`, `session_persist.zig` — cầu nối giữa `profile/` (fingerprint/identity) và việc lưu/khôi phục trạng thái phiên (`profile_session.bootstrap`, `profile_session.persist`, `session_persist.loadStorage`, `session_persist.saveStorage` — tên hàm khớp 100% với các dòng log INFO đã thấy nhiều lần trong session debug).

## 11. Bảng tra cứu nhanh

| Cần làm gì | Xem file |
|---|---|
| Vì sao arena bị leak crash lúc thoát | `ArenaPool.zig` + grep nhãn `debug=` trong log lỗi |
| Vì sao 1 request/transfer không bao giờ hoàn tất | `network/layer/InterceptionLayer.zig` (điểm nghi vấn) đối chiếu `src/core/browser/HttpClient.zig` (transfer thật) |
| Cache HTTP hoạt động ra sao | `network/layer/CacheLayer.zig` + `network/cache/{Cache,FsCache}.zig` |
| WebRTC chạy trên thread nào | `network/WebRtcThread.zig` + `RtcCommandQueue.zig`/`RtcEventQueue.zig` |
| Chính sách huỷ khi navigate (chống UAF) | `RealmLifecycleKernel.zig` (đọc docstring đầu file trước) |
| Cờ CLI ánh xạ vào đâu | `Config.zig` |
| Fingerprint 1 vector cụ thể (canvas/audio/webgl...) | `profile/*Intelligent.zig` tương ứng + `knowledge/fingerprint/<vector>/` |
| Cookie/localStorage lưu ở đâu, format gì | `storage/Storage.zig`, `cookies.zig`, `~/Library/Application Support/koko/<profile>/` |
| IndexedDB backend | `storage/sqlite/*.zig` (khớp commit gần nhất "IndexedDB, lifecycle") |
| Sự kiện nội bộ browser (navigate, frame created...) | `Notification.zig` — tìm `notification.dispatch(.X, ...)` |
| robots.txt / Web Bot Auth | `network/Robots.zig`, `network/WebBotAuth.zig`, `network/layer/RobotsLayer.zig` |
| App khởi tạo/dọn dẹp theo thứ tự nào | `App.zig` |
