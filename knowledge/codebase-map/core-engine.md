# Core Engine — bản đồ chi tiết (`src/core/`)

> Tầng `Core Engine` trong kiến trúc `Core Engine -> Runtime -> Protocols -> Adapters -> Public API`. 401 file `.zig`. Đây là engine trình duyệt thật: DOM, parser HTML, binding V8/JS, và toàn bộ Web API. Viết dựa trên đọc trực tiếp source (Frame.zig, Runner.zig, ScriptManagerBase.zig, HttpClient.zig, TaggedOpaque.zig, EventLoop.zig, IceAgent.zig đã được đọc sâu trong một phiên debug thực tế trước đó — xem `pitfalls-and-invariants.md` để biết chi tiết case study).

## 1. Tổng quan luồng dữ liệu

```
HTML bytes --(parser/html5ever)--> DOM tree (dom/)
                                       |
                                       v
                          JS thấy DOM qua binding (js/ + webapi/)
                                       |
                                       v
                    browser/ điều phối vòng đời Frame/Page/Session,
                    network (HttpClient), script loading (ScriptManagerBase),
                    và event loop (Runner.zig tick loop)
```

## 2. `src/core/browser/` (33 file) — bộ khung trung tâm

Đây là nơi các khái niệm "trình duyệt" cấp cao được lắp ráp: Frame, Page, Session, Browser, HTTP, script lifecycle, event loop.

- **`Browser.zig`** — đối tượng gốc của một phiên trình duyệt: sở hữu `env` (JS environment), `http_client`, `session`. `runMacrotasks()` là hàm trung tâm chạy mỗi tick: `env.runMicrotasks(.macrotask_loop)` → `env.runMacrotasks()` → `env.pumpMessageLoop()` → `env.runMicrotasks()` lần nữa → `drainAllRtcEvents()`. `msToNextMacrotask()` cho biết còn bao lâu tới macrotask kế tiếp — được `Runner._tick()` dùng để quyết định ngủ bao lâu.
- **`Frame.zig`** (file lớn, trung tâm nhất) — đại diện 1 browsing context (root hoặc iframe con). Sở hữu: `navigate()` (điều hướng — log `"frame : navigate"` bạn thấy trong mọi log xuất phát từ đây), `_load_state` (enum: `parsing → load → complete`, dùng bởi `isDocumentParsing()` và điều kiện `--wait-until`), `_parse_state` (`pre/raw/text/image/html/complete/err/raw_done` — dùng bởi `Runner._tick()`), `child_frames` (danh sách iframe con), `iframeSandboxFlags()` (đọc từ `IFrameSandbox.zig`), `applySandboxOrigin`, `prepareForOutgoingAbort` (bước 1 của hợp đồng cancel-on-nav — xem `pitfalls-and-invariants.md` mục 2), `bumpRealmNavigationEpoch()`, `_script_manager: ScriptManagerBase`, `js.execution` (con trỏ vào execution context JS của frame này). Khi cần hiểu "vì sao 1 trang không load xong" hay "iframe được tạo/huỷ ra sao" → luôn bắt đầu từ file này.
- **`Runner.zig`** — vòng lặp chờ (`_wait()` → lặp `_tick()` → `std.Thread.sleep()`). Đây LÀ engine quyết định khi nào CLI `fetch --wait-ms N --wait-until X` trả kết quả. `_tick()` là state machine theo `frame._parse_state`; nhánh `.complete` tính `script_pending = hasPendingJsWork()`, `network_idle`, `is_done`, `immediate_host_work`, rồi quyết định `ms_to_wait` (có thể bị ép về 0 → spin CPU nếu `script_pending` kẹt true mãi — xem case study đầy đủ ở `pitfalls-and-invariants.md` mục 7, đã điều tra tới tận gốc rễ network/curl thật). **Đây là file quan trọng nhất để hiểu mọi hiện tượng "treo"/"chạy hết wait-ms mà không xong".**
- **`ScriptManagerBase.zig`** — vòng đời script HTML (`<script>` classic/module, static/defer/async). Các list: `defer_scripts`, `async_scripts`, `ready_scripts`. Cờ quan trọng: `static_scripts_done`, `is_evaluating`, `evaluate_pending`, `deferred_evaluate_queued`, `pending_element_callbacks`. `hasPendingJsWork()` = OR của tất cả cờ trên + 2 hàm private `hasPendingEvaluateWork()`/`hasIncompleteLifecycleScripts()`. `Script.doneCallback()` set `script.complete = true` — **chỉ được gọi khi transfer HTTP thật sự hoàn tất ở tầng dưới** (không phải khi interception layer báo xong — 2 tín hiệu khác nhau, xem case study). `pumpDocumentLifecycle()` chỉ bơm tiếp evaluate khi `frame.isDocumentParsing()` còn true (đã thử nới lỏng điều kiện này trong phiên debug, KHÔNG phải nguyên nhân của bug đã gặp, đã revert).
- **`HttpClient.zig`** — client HTTP cấp cao mà Frame/ScriptManager gọi (`request()`, `tick()`). Có curl multi-handle riêng (`self.handles`), connection pool, `dirty` list (connection cần release), `ready_queue` (connection chờ được promote vào multi-handle). `perform()` trả `PerformStatus` (`normal`/`idle`/`cdp_socket`) — `.idle` là tín hiệu DUY NHẤT cho phép `Runner` ngủ thay vì spin. `ensureRequestAttribution()` bắt buộc mọi request document phải gắn `attribution_frame` — thiếu sẽ panic trong Debug build (bước 2 hợp đồng cancel-on-nav). Khác với `src/runtime/network/Network.zig` (có multi-handle RIÊNG) — đừng nhầm 2 lớp mạng này (xem `runtime-and-network.md`).
- **`Session.zig`** — quản lý nhiều Page/Frame trong 1 phiên, cookie jar (`session.cookie_jar.beginDocumentNavigation()`), `currentFrame()`/`pendingOrCurrentFrame()`, `processQueuedNavigation()`, `drainDeferredCommit()` (xử lý navigation bị "park" khi JS đang chạy trên V8 stack lúc HttpClient nhận response — comment trong Runner.zig giải thích rõ tình huống).
- **`Page.zig`** — 1 tab/trang, chứa Frame gốc + các state liên quan tới popup (`cleanupClosedPopups()`).
- **`EventManager.zig` / `EventManagerBase.zig`** — hệ thống dispatch DOM event (khác với `Notification.zig` bên `runtime/` — đây là event *DOM* như click/load, không phải sự kiện nội bộ browser).
- **`Factory.zig`** — factory tạo đối tượng DOM/JS (constructor pattern tập trung).
- **`InputController.zig`, `HumanInput.zig`** — điều khiển input giả lập (click, gõ phím) — `HumanInput.zig` gợi ý có mô phỏng hành vi người dùng thật (timing, easing) để né bot-detection dựa trên input pattern.
- **`IFrameSandbox.zig`** — parse thuộc tính `sandbox` của `<iframe>` (`allow-same-origin`, `allow-scripts`...), quyết định `blocksScripts()`/`usesOpaqueOrigin()`.
- **`LoadGuard.zig`** — có khả năng là cơ chế gate cho sự kiện `load` (liên quan `knowledge/architecture/2026-07-09-load-guard-navigation-gate.md`).
- **`GoogleChromeTransport.zig`** — hiện thực `--google-chrome-transport` (route document navigation của google.com/search qua Chrome thật, né gap QUIC fingerprint của curl — theo mô tả trong `--help`).
- **`ContentSecurityPolicy.zig`** — parse/áp dụng CSP header (đã thấy CSP phức tạp trong response Cloudflare interstitial lúc debug).
- **`ReferrerPolicy.zig`, `Mime.zig`, `URL.zig`, `color.zig`** — tiện ích domain-specific.
- **`StyleManager.zig`, `css/`** — quản lý CSSOM / style áp dụng (thư mục con `css/` bên trong `browser/`, khác với `webapi/css/`).
- **`dump.zig`, `markdown.zig`, `reflect.zig`, `structured_data.zig`, `forms.zig`, `links.zig`, `interactive.zig`, `actions.zig`** — hỗ trợ các chế độ `--dump` của CLI (`html`, `markdown`, `semantic_tree`, `semantic_tree_text`) và các helper trích xuất (forms, links, structured data — kiểu JSON-LD/microdata) — đây là tầng phục vụ trực tiếp output của `velora fetch`.

## 3. `src/core/dom/` (20 file) — DOM tree

`Node.zig`, `Element.zig`, `Document.zig`, `DocumentFragment.zig`, `DocumentType.zig` — cấu trúc DOM chuẩn. `AttrAssociatedElement.zig` — liên kết attribute↔element. `DOMImplementation.zig`, `DOMParser.zig`, `XMLSerializer.zig`(ở webapi) — tạo/parse/serialize document. `DOMException.zig` — lỗi DOM chuẩn (kiểu `NotFoundError`...). `DOMMatrix*.zig`, `DOMPoint*.zig`, `DOMRect*.zig`, `SVGRect.zig` — kiểu hình học dùng bởi CSSOM/SVG/Canvas API. `DOMTreeWalker.zig`, `TreeWalker.zig`, `DOMNodeIterator.zig`, `NodeFilter.zig` — traversal API chuẩn (`document.createTreeWalker`...).

## 4. `src/core/js/` (33 file) — tầng binding V8

Đây là lớp "dịch" giữa Zig struct và V8 JS object.

- **`Env.zig`** — môi trường V8 tổng: `runMicrotasks()`, `runMacrotasks()`, `pumpMessageLoop()`, `anyContextOnV8Stack()`, `checkpoint_active`/`checkpoint_pending` (cờ theo dõi microtask checkpoint — xuất hiện trong mọi log debug dạng `browser : promise.resolve checkpoint_active=false checkpoint_pending=true`), `memoryPressureNotification()`.
- **`Context.zig`** — 1 V8 context (≈ 1 realm JS, gắn với 1 Frame). `call_depth` dùng bởi `isHostNested()`.
- **`TaggedOpaque.zig`** — cơ chế lõi để Zig struct "trở thành" JS object. Khi trả 1 Zig struct về V8, nó được cấp phát trên heap và gắn vào `InternalField` của V8 Object dưới dạng `*anyopaque` + tag (index kiểu trong bảng `Types`). Lý do cần tag: (1) JS có thể gọi method với tham số sai kiểu (`cat.setOwner(new Cat())` thay vì `new Owner()`), (2) chuỗi kế thừa prototype (Owner kế thừa Person) khiến kiểu "đúng" mong đợi khác kiểu thực. `TaggedOpaque` lưu `prototype_chain` để giải quyết cả 2. Mọi cast dùng `@alignCast` đều có `std.mem.isAligned()` guard trả `error.InvalidArgument` thay vì panic — **ngoại lệ**: không phải MỌI `@alignCast` trong codebase đều được guard như vậy (đã xác nhận qua 1 panic `incorrect alignment` thật ở nơi khác — xem `pitfalls-and-invariants.md` mục 5).
- **`bridge.zig`** — `JsApiLookup`, `Struct(T).JsApi` — ánh xạ comptime giữa 1 Zig type và "API JS" của nó (tên method, getter/setter).
- **`Value.zig`, `Local.zig`, `Object.zig`, `Array.zig`, `Function.zig`, `String.zig`, `Number.zig`, `Integer.zig`, `BigInt.zig`, `RegExp.zig` — wrapper kiểu V8 cơ bản.
- **`Promise.zig`, `PromiseResolver.zig`, `PromiseRejection.zig`** — Promise binding.
- **`HandleScope.zig`, `TryCatch.zig`** — RAII wrapper cho V8 handle scope / exception catching.
- **`Caller.zig`, `Identity.zig`** — gọi hàm Zig từ callback V8; `Identity` khả năng là identity-map (đảm bảo 1 Zig object → luôn cùng 1 JS object, tránh 2 wrapper cho cùng 1 identity — comment trong `TaggedOpaque.zig` có nhắc "make sure window._location is at a unique address").
- **`Inspector.zig`** — hỗ trợ CDP domain `Runtime`/`Debugger` (V8 Inspector protocol) — cầu nối tới `src/protocols/cdp/`.
- **`EventLoop.zig`** — helper spin vòng lặp host (đọc kỹ, chi phối rất nhiều bug treo). Hàm cốt lõi:
  - `isHostNested(exec)`: true nếu đang trong `checkpoint_active`, `call_depth > 0`, có context nào đang trên V8 stack, hoặc `JsEntryGate.scriptEvalActive`. Khi true → **cấm chạy timer/macrotask mới** (chỉ được microtask).
  - `spin()` / `spinOnce()` / `spinUntil()`: chạy macrotask ready tới khi hết budget hoặc hết việc.
  - `hasReadyWork(exec)` = `exec._scheduler.hasReadyTasks()` — dùng trực tiếp bởi `Runner._tick()` để tính `immediate_host_work`.
  - `drainMicrotasksNested()`: an toàn khi đang nested (không đụng timer), chỉ microtask + schedule deferred pump.
  - `afterDomMutation()`: gọi sau khi DOM bị mutate từ host (appendChild, sync iframe load...).
  - Bảng so sánh 4 API (nested vs top-level, có chạy timer không, có chạy microtask không) nằm ngay đầu file dưới dạng comment — đọc trước khi sửa bất cứ gì ở đây.
- **`Scheduler.zig`** — hàng đợi task có `add()`/`runOne()`/`run()`/`hasReadyTasks()` — nền tảng cho `setTimeout`/`setInterval`/deferred callback.
- **`JsEntryGate.zig`** — gate kiểm soát điểm vào/ra V8 execution.
- **`Execution.zig`** — gắn 1 `Context` + `_scheduler` — đơn vị "1 luồng thực thi JS" mà `EventLoop.zig` thao tác lên.
- **`Isolate.zig`, `Platform.zig`, `Snapshot.zig`** — hạ tầng V8 cấp thấp (Isolate = 1 instance V8 engine; Snapshot = heap đã build sẵn, build bằng `zig build snapshot_creator`, xem `build-and-dependencies.md`).
- **`Origin.zig`, `Module.zig`, `Private.zig`** — origin JS (script origin cho stack trace), ES module binding, private field V8.
- **`*.js` files** (`creepjs_compat_shim.js`, `creepjs_features_reorder.js`, `url_historical_shim.js`, `usp_constructor_shim.js`, `websocket_constructor_shim.js`, `worker_construct_depth.js`, `worker_constructor_shim.js`, `worker_intl_shim.js`, `shared_worker_constructor_shim.js`) — **JS thật được nhúng/chạy trong mọi realm** để vá hành vi constructor/thứ tự property mà việc bind trực tiếp từ Zig khó tái tạo chính xác (ví dụ thứ tự enumerate property mà CreepJS dùng để phát hiện — khớp `knowledge/bugs/2026-06-29-creepjs-*`).

## 5. `src/core/parser/` + `src/core/html5ever/` — HTML parsing

- **`parser/Parser.zig`** — cầu nối Zig, nhận token từ html5ever, dựng DOM node (`parser.parse(html_bytes)`), có `parser.err` để báo lỗi parse.
- **`parser/html5ever.zig`** — FFI binding sang thư viện Rust `html5ever` (crate nội bộ tại `src/core/html5ever/`, biên dịch qua `cargo` — xem `build-and-dependencies.md`, mục V8/html5ever). Rust crate: `Cargo.toml`, `lib.rs`, `sink.rs` (nơi cắm "sink" nhận sự kiện token từ html5ever để gọi ngược lại Zig), `types.rs`.

## 6. `src/core/xpath/` — XPath

`Tokenizer.zig` → `Parser.zig` → `ast.zig` → `Evaluator.zig` (+ `functions.zig` cho hàm XPath built-in, `result.zig` cho kiểu kết quả) — pipeline XPath chuẩn, phục vụ `document.evaluate()` / `XPathEvaluator` (webapi).

## 7. `src/core/profile/` và `src/core/semantic/`

- **`profile/types.zig`** — kiểu dữ liệu profile dùng chung ở tầng core (khác `src/runtime/profile/` — đó là logic fingerprint/spoofing thật; đây chỉ là type definitions dùng bởi core).
- **`semantic/SemanticTree.zig`** — nền tảng cho `--dump semantic_tree`/`semantic_tree_text` (tạo cây ngữ nghĩa trang, có thể phục vụ mục đích AI-agent đọc trang thay vì đọc HTML thô).

## 8. `src/core/webapi/` (305 file) — Web Platform APIs, phân loại theo thư mục con

| Thư mục | Số file | Nội dung |
|---|---:|---|
| `element/` | 92 | Cài đặt từng loại HTML element (`element/html/*.zig` — ví dụ `IFrame.zig` đã đọc trực tiếp: sở hữu logic `_window`, `_executed`, liên kết `IFrameSandbox`). Đây là subsystem con lớn nhất trong toàn bộ `webapi/`. |
| `net/` | 24 | Networking phía JS: `fetch`, `XMLHttpRequest`, WebSocket JS binding, và **`net/rtc/`** (WebRTC: `IceAgent.zig`, `RTCPeerConnection.zig`, `SctpTransport.zig` — đã đọc trực tiếp `IceAgent.zig`: `gatherHostCandidates()` dùng `getifaddrs()`, `handleStunMessage()`/`handleCheckResponse()`/`handleInboundCheck()` parse STUN packet bằng `readInt`/`memcpy` an toàn — không phải nguồn gốc panic `incorrect alignment` đã gặp). |
| `event/` | 30 | Hệ thống Event/EventTarget JS-facing, các loại event cụ thể (MouseEvent, KeyboardEvent...). |
| `css/` | 12 | CSSOM JS-facing (`CSSStyleDeclaration`, `CSSRule`...) — khác `browser/css/` (style engine nội bộ). |
| `collections/` | 10 | `NodeList`, `HTMLCollection` và các collection khác. |
| `streams/` | 9 | Streams API (`ReadableStream`, `WritableStream`...). |
| `canvas/` | 9 | Canvas 2D API — liên quan `runtime/profile/CanvasIntelligent.zig` + `NativeCanvas.zig` cho fingerprint giả lập. |
| `crypto/` | 8 | Web Crypto API (`SubtleCrypto` ở top-level webapi/, các thuật toán con nằm ở đây). |
| `media/` | 6 | Media API (audio/video element support cấp thấp). |
| `encoding/` | 5 | `TextEncoder`/`TextDecoder`. |
| `cdata/` | 4 | CharacterData-family DOM node (Text, Comment, CDATASection). |
| `navigation/` | 4 | Navigation API (khác `History.zig` ở top-level). |
| `selector/` | 3 | CSS selector engine dùng cho `querySelector`. |
| `svg/` | 2 | SVG DOM. |
| `storage/` | 2 | `localStorage`/`sessionStorage` JS binding (khác `runtime/storage/` là backend lưu trữ thật). |
| `animation/`, `audio/`, `speech/` | 1 mỗi loại | Web Animations, Audio API cấp cao, Speech API — cài đặt tối giản/stub khả năng cao (1 file). |
| `assets/` | 0 | Thư mục rỗng hoặc chỉ chứa non-.zig asset. |

**File top-level đáng chú ý** (không nằm trong thư mục con): `Window.zig` (global object — trung tâm mọi API global), `Navigator.zig`/`NavigatorUAData.zig`/`NavigatorState.zig`/`navigator_extras.zig` (fingerprint-sensitive nhất — `navigator.userAgent`, `navigator.plugins` qua `PluginArray.zig`...), `Location.zig`, `History.zig`, `Performance.zig`/`PerformanceObserver.zig`, `idb.zig` (IndexedDB — backend thật ở `runtime/storage/sqlite/`), `cookie_store.zig` (Cookie Store API), `MutationObserver.zig`, `IntersectionObserver.zig`, `ResizeObserver.zig`, `Worker.zig`/`WorkerGlobalScope.zig`/`DedicatedWorkerGlobalScope.zig`/`SharedWorkerGlobalScope.zig`/`shared_worker.zig` (Web Worker toàn bộ, kể cả Shared Worker), `MessageChannel.zig`/`MessagePort.zig`/`broadcast_channel.zig` (giao tiếp liên-realm/liên-tab), `Screen.zig`/`VisualViewport.zig` (fingerprint màn hình), `Permissions.zig`, `NetworkInformation.zig`, `BatteryManager.zig` (fingerprint phần cứng/mạng), `Chrome.zig` (giả lập `window.chrome` object mà Chrome thật có, non-Chromium engine khác thường thiếu — dấu hiệu phát hiện phổ biến), `WebDriver.zig` (liên quan che giấu `navigator.webdriver`), `CustomElementRegistry.zig`/`CustomElementDefinition.zig` (Custom Elements v1), `AbortController.zig`/`AbortSignal.zig`, `trusted_types.zig` (Trusted Types API), `credentials_api.zig` (Credential Management API), `scheduler_api.zig`/`task_scheduling.zig` (`scheduler.postTask`), `dom_notification.zig` (Notification API), `cache_storage.zig` (Cache API cho Service Worker), `IdleDeadline.zig` (`requestIdleCallback`), `Timers.zig` (`setTimeout`/`setInterval` — điểm neo trực tiếp vào `js/Scheduler.zig`).

## 9. Bảng tra cứu nhanh

| Cần làm gì | Xem file |
|---|---|
| Sửa hành vi navigate/iframe | `browser/Frame.zig` |
| Vì sao wait loop không hội tụ / spin CPU | `browser/Runner.zig` `_tick()` + `js/EventLoop.zig` `isHostNested`/`hasReadyWork` |
| Script `<script>` không chạy đúng thứ tự | `browser/ScriptManagerBase.zig` |
| Request HTTP không hoàn tất | `browser/HttpClient.zig` (transfer/dirty/release) |
| V8 object ↔ Zig struct ánh xạ thế nào | `js/TaggedOpaque.zig` + `js/bridge.zig` |
| HTML parse ra DOM | `parser/Parser.zig` + `parser/html5ever.zig` + Rust crate `html5ever/` |
| 1 Web API cụ thể (fetch, IndexedDB, Worker...) | Tra bảng mục 8, hoặc `grep -rn "pub const <TenAPI>"` trong `webapi/` |
| WebRTC / ICE | `webapi/net/rtc/IceAgent.zig`, `RTCPeerConnection.zig`, `SctpTransport.zig` |
| CDP Inspector/Runtime domain nối vào JS ở đâu | `js/Inspector.zig` |
| CSP áp dụng ở đâu | `browser/ContentSecurityPolicy.zig` |
| `--dump markdown`/`semantic_tree` sinh ra sao | `browser/markdown.zig`, `core/semantic/SemanticTree.zig` |
| iframe `sandbox="..."` được xử lý ở đâu | `browser/IFrameSandbox.zig` |
| XPath | `xpath/Evaluator.zig` |
| JS shim vá hành vi constructor/thứ tự property | `js/*.js` (danh sách ở mục 4) |

## 10. Ghi chú quan trọng: `src/public/` KHÔNG phải API thật đang dùng

Khi đọc kiến trúc README (`Core Engine -> Runtime -> Protocols -> Adapters -> Public API`), dễ hiểu lầm `src/public/` là nơi lập trình viên Zig/embedder gọi vào. Thực tế đã kiểm chứng: **`src/public/Frame.zig` hiện chỉ là stub** — `goto()`, `content()`, `evalString()` đều là thân hàm rỗng (`_ = url; _ = self;`, trả `""`). API thật mà người dùng cuối dùng là:
1. **CDP** (`src/protocols/cdp/`) qua `velora serve` — dùng bởi SDK ngoài (`@velora/sdk`, repo riêng `velora-sdk`).
2. **CLI** (`velora fetch ...`) qua `src/adapters/cli/`.

Xem `knowledge/codebase-map/protocols-and-adapters.md` để biết chi tiết 2 đường API thật này.
