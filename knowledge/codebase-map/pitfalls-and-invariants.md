# Cạm bẫy & bất biến đã biết (Pitfalls & Invariants)

> File này gom lại những điều "phải biết trước khi sửa code" mà nếu không đọc, AI/dev sẽ lặp lại sai lầm đã có người mắc phải. Nguồn: `AGENTS.md`, `RealmLifecycleKernel.zig`, thống kê thực tế từ `export-logs/`, và một phiên debug trực tiếp (grok.com/Cloudflare) đã lần theo tới tận gốc rễ trong engine. Đọc file này TRƯỚC khi sửa bất cứ gì liên quan lifecycle/network/JS realm.

## 1. Luật vàng của dự án (từ `AGENTS.md`) — đọc file gốc, đây chỉ là tóm tắt

- **Cấm tuyệt đối** vá theo hostname/URL/product name/CSS class/DOM id/framework fingerprint của MỘT site cụ thể. Nếu một fix không giải thích được mà không nhắc tên site đã gây ra nó → dừng lại, thiết kế lại theo đúng invariant của web platform.
- Mọi fix hành vi trình duyệt phải xác định trước: invariant nào bị vi phạm (DOM, HTML, CSS/layout, navigation, event loop, networking, resource lifecycle, JS realm, hay serialization) — rồi sửa ĐÚNG component sở hữu invariant đó, không vá bù ở CLI/exporter/automation layer hay ở giai đoạn lifecycle sau.
- Ưu tiên: ownership rõ ràng, state transition, generation/epoch, invalidation — thay vì sleep, retry, magic constant, hay hậu xử lý HTML đã sinh ra.
- Mọi arena, response, handle, listener, task phải có ĐÚNG MỘT chủ sở hữu và ĐÚNG MỘT đường giải phóng cuối cùng, an toàn qua mọi nhánh: success, error, cancel, navigate, timeout, shutdown, stale-realm.
- Cache = derived state — phải định nghĩa key, generation, invalidation contract trước khi đụng vào.
- Quy trình bắt buộc cho mỗi fix: (1) reproduce + ghi bằng chứng từ state lõi (không chỉ nhìn giao diện cuối), (2) phát biểu invariant tổng quát bị vi phạm, (3) soát mọi caller/terminal path chia sẻ state đó, (4) fix nhỏ nhất áp dụng được cho MỌI trang, (5) thêm regression test tối thiểu không phụ thuộc mạng thật, (6) chạy test hẹp rồi test rộng hơn, (7) dùng site thật chỉ để kiểm tra tích hợp SAU KHI test xác định đã pass — không bao giờ encode site đó vào production logic, (8) báo cáo lỗi còn sót riêng, không giấu bằng CSS fallback/rewrite DOM/sleep/dọn dẹp không liên quan.

## 2. "Cancel-on-nav" — hợp đồng chống use-after-free trung tâm

Xem `src/runtime/RealmLifecycleKernel.zig` (đọc docstring đầu file). 4 bước bắt buộc khi 1 frame điều hướng đi:

1. **Realm**: `Frame.prepareForOutgoingAbort` → state `.draining`, dừng script, huỷ streaming parser, `cancelOwnedSchedulerWork()`.
2. **Network**: mọi transfer gắn `RequestParams.attribution_frame`; thiếu gắn → log + **panic trong Debug build** (`ensureRequestAttribution` trong `src/core/browser/HttpClient.zig`).
3. **Scheduler**: chỉ chạy qua `Frame.runOwnedScheduler*`, có gate `canRunOwnedScheduler`.
4. **Parser**: sau mỗi lần poll CDP, re-check `_realm_state == .active` trước khi mutate DOM.

`TaskOwner{realm_id, epoch, document_id}` gắn vào mọi việc async để tự phát hiện "việc này thuộc navigation cũ (stale), tự huỷ thay vì chạy lên DOM đã chết". **Phần lớn bug UAF/race trong `knowledge/bugs/` là do một đường code nào đó bỏ qua 1 trong 4 bước này** — ví dụ: giữ pointer vào Frame/Document qua một callback bất đồng bộ (network, timer, WebRTC, MessagePort) mà không kiểm tra epoch/state trước khi dùng lại.

**State máy 4 trạng thái**: `initializing → active → draining → dead`. Không được schedule việc mới khi `draining` hoặc `dead`.

## 3. `ArenaPool: leaked arenas detected` — 48/62 crash log quan sát được, phổ biến nhất

Cơ chế (xem `src/runtime/ArenaPool.zig`): mỗi `arena_pool.acquire(size, "some-label")` ghi 1 nhãn debug vào `_leak_track` (Debug build only). Nếu khi `App.deinit()` (kết thúc tiến trình) mà bất kỳ nhãn nào có counter ≠ 0 → `@panic("ArenaPool: leaked arenas detected")`.

**Cách chẩn đoán khi gặp**: đọc log lỗi tìm `name=<label> count=N`, rồi `grep -rn 'acquire(.*"<label>"' src/` để tìm call site, rồi soát mọi nhánh return/error/panic giữa `acquire` và `release` tương ứng — gần như chắc chắn có 1 đường thoát sớm quên gọi `releaseArena`/`session().releaseArena(arena)`.

## 4. `reached unreachable code` — 11/62 crash log

Nghĩa đen: một nhánh `unreachable` trong Zig bị chạm tới trong thực tế (giả định lập trình sai). Không có shortcut chẩn đoán chung — cần stack trace. Xem mục 6 bên dưới về hạn chế stack trace của dự án này.

## 5. `incorrect alignment` — hiếm, race condition (đã điều tra sâu 1 ca thật)

Panic Zig runtime an toàn khi `@alignCast`/`@ptrCast` phát hiện con trỏ không đúng alignment yêu cầu. Đã điều tra 1 ca thật trên `grok.com`: crash xảy ra ngay sau `webrtc: STUN srflx candidate` và trong lúc `frame: navigate` vào iframe Turnstile — nghi vấn cao nhất là race giữa callback bất đồng bộ WebRTC (đến từ `WebRtcThread` — thread RIÊNG, xem `runtime-and-network.md` mục 5) và việc realm/frame của iframe đang được tạo/teardown cùng lúc, tức là VI PHẠM chính hợp đồng "cancel-on-nav" ở mục 2 (một callback async chạm vào frame đúng lúc nó đang khởi tạo hoặc bị huỷ).

**Không tái hiện được ổn định**: thử lại 10 lần liên tiếp trong 1 phiên debug, 0 lần crash lại. Đây là race condition thật, không phải lỗi tất định — đừng cố "fix" nó chỉ dựa trên 1 log duy nhất; cần bắt sống bằng `lldb -o run -o "thread backtrace all"` nhiều lần, hoặc thêm log ngữ cảnh (frame id, realm state, con trỏ) ngay trước điểm `@alignCast` khả nghi trong `src/core/webapi/net/rtc/IceAgent.zig` / `src/core/browser/Frame.zig` trước khi kết luận.

## 6. Stack trace panic gần như luôn vô dụng — biết trước để không mất thời gian

`build.zig` (~dòng 130) **luôn set `strip = true`** kể cả ở Debug build, vì lý do: *"Zig 0.15.2: LLVM+Debug SIGSEGV in lowerDebugType; native+Debug SIGSEGV in updateLazySymbol. Strip debug info in Debug builds to avoid LLVM debug-type recursion."* — tức là build với debug info đầy đủ khiến CHÍNH TRÌNH BIÊN DỊCH Zig 0.15.2 crash. Hệ quả: `crash_handler.zig` (bộ xử lý panic tuỳ biến của Velora, in ra "Velora has crashed...") sẽ luôn in `Unable to dump stack trace: debug info stripped`.

**Cách lách**: binary KHÔNG bị strip symbol table hoàn toàn (đã kiểm chứng: `nm zig-out/bin/velora | wc -l` ra ~264,000 symbol) — chỉ thiếu debug line-info. Chạy trực tiếp dưới `lldb`:
```bash
lldb -b -o "run" -o "thread backtrace all" -o "quit" -- ./zig-out/bin/velora fetch ... <url>
```
sẽ cho tên hàm (không có số dòng chính xác) khi bắt được crash — vẫn hữu ích hơn nhiều so với log mặc định.

## 7. Vòng lặp wait/tick có thể busy-spin 100% CPU mà KHÔNG crash, KHÔNG timeout đúng nghĩa — đã điều tra tận gốc 1 ca thật

Đây là bug loại nguy hiểm nhất vì **không có triệu chứng lỗi rõ ràng** — export chỉ "chạy hết `--wait-ms` rồi trả về nội dung dở dang", trông giống site chặn bot chứ không giống bug engine.

**Cơ chế** (đọc `src/core/browser/Runner.zig` hàm `_tick()`, nhánh `.complete`):
```
script_pending = live_frame._script_manager.base.hasPendingJsWork()
...
} else if (script_pending) {
    ms_to_wait = 0;   // <-- ép không sleep
}
...
return .{ .ok = 0 };  // <-- nếu http_client.tick() không trả .idle, luôn trả 0
```
Nếu `ms_to_wait` bị ép về 0 liên tục (do `script_pending == true` mãi mãi) HOẶC `http_client.tick()` không bao giờ trả `PerformStatus.idle`, vòng `while(true)` ở `Runner._wait()` không bao giờ `std.Thread.sleep()` → CPU 100%, hàng trăm nghìn lần gọi `microtask.checkpoint` mỗi giây, cho tới khi hết `--wait-ms` từ CLI ép dừng cứng.

**Ca thật đã trace ra tận gốc** (grok.com, script `api.js` của Cloudflare Turnstile):
- `hasPendingJsWork()` = true mãi mãi, cụ thể do nhánh con `hasIncompleteLifecycleScripts()` (không phải `is_evaluating`/`evaluate_pending`/`deferred_evaluate_queued` như đoán ban đầu — **đã verify bằng log, đừng đoán, hãy thêm diagnostic log rồi verify**).
- Nguyên nhân sâu hơn: `Script.complete` (cờ mà `hasIncompleteLifecycleScripts()` kiểm tra) chỉ được set `true` trong `Script.doneCallback()` (`src/core/browser/ScriptManagerBase.zig`) — và hàm này chỉ được gọi khi TRANSFER HTTP THẬT SỰ hoàn tất ở tầng dưới.
- Nhưng: `network/layer/InterceptionLayer.zig` có callback riêng log `"intercept done"` khi đã nhận đủ `content_length` byte — tín hiệu này KHÔNG đồng nghĩa với transfer thật đã đóng. Đối chiếu network log thực tế: request `api.js` có `"intercept done"` (đủ 82,469 byte) nhưng KHÔNG BAO GIỜ có `"release connection"` theo sau → transfer bị "treo" ở tầng curl dù dữ liệu đã tới đủ.
- Hệ quả kép: `http_active` kẹt ở 1 mãi mãi (network không bao giờ idle) VÀ `Script.complete` kẹt `false` mãi mãi (script không bao giờ được coi là xong) — hai triệu chứng, một gốc rễ.

**Bài học phương pháp luận** (áp dụng cho mọi bug "treo không rõ lý do" tương lai):
1. Đừng đoán biến nào bị kẹt — thêm log chẩn đoán trực tiếp vào TỪNG cờ con (`evaluate_pending`, `deferred_evaluate_queued`, `pending_element_callbacks`, `is_evaluating`, rồi mới tới 2 hàm private `hasPendingEvaluateWork()`/`hasIncompleteLifecycleScripts()` — cần expose tạm qua wrapper `pub fn debugXxx()` nếu private).
2. Dùng `--log-level debug --log-dir <path>` (xem `runtime-and-network.md`/CLI flags) để có log network/core tách riêng theo scope — log INFO mặc định QUÁ THƯA để thấy busy-spin (chỉ thấy im lặng 19s rồi hết giờ).
3. Đối chiếu `"intercept start"`/`"intercept done"` với `"release connection"` theo TỪNG url trong `network/all.log` để phát hiện transfer bị treo (đếm số lượng mỗi loại phải khớp).
4. **Sau khi fix, PHẢI đo lại bằng đúng diagnostic log đó** — đừng chỉ nhìn exit code/HTML output. Trong phiên debug này, 1 fix "hợp lý về lý thuyết" (nới lỏng gate `pumpDocumentLifecycle`) đã được áp dụng, build, chạy lại — nhưng số liệu chẩn đoán (`scheduler.add`/`scheduler.runTask` không đổi) chứng minh fix đó KHÔNG chạm vào nguyên nhân thật, nên đã bị revert. Đừng tin vào một fix chỉ vì nó "nghe hợp lý" và build được — phải đo bằng chứng.
5. Root cause thật của ca này (transfer curl không bao giờ release dù dữ liệu đủ) chưa được vá — cần đọc sâu `src/core/browser/HttpClient.zig` (đường xử lý `dirty`/`releaseConn`/`curl_multi_info_read`) đối chiếu với `InterceptionLayer.zig`, rất có thể liên quan tới response HTTP/2 từ Cloudflare không được nghi nhận đúng "stream end" — cần capture verbose curl hoặc so sánh header response trước khi vá (đây là việc CHƯA XONG, để lại cho phiên sau).

## 8. Đĩa cứng: `.zig-cache/` có thể phình tới 20-24GB — an toàn để xoá

Gặp thật trong session này: build fail với `error: failed to write: NoSpaceLeft` không phải do lỗi code mà do `.zig-cache/` chiếm 24GB trên đĩa gần đầy (335MB trống). `rm -rf .zig-cache` là an toàn (cache biên dịch Zig, tự tạo lại, giống `node_modules`) — build lại sẽ compile lại từ đầu (vài phút, không phải giờ). **KHÔNG xoá `.velora-cache/`** (~9GB, chứa V8 + depot_tools đã bootstrap sẵn) — xoá cái này sẽ buộc tải/build lại V8 rất lâu.

## 9. Danh mục bug đã biết trong `knowledge/bugs/` (tra cứu trước khi báo "phát hiện bug mới")

Nhóm theo chủ đề (tên file đầy đủ nằm trong `knowledge/bugs/`, xem `codebase-map` khác hoặc `ls knowledge/bugs/`):

| Nhóm | Ví dụ file | Bản chất |
|---|---|---|
| Use-after-free | `profile-local-state-use-after-free`, `document-open-uaf-cors-preflight`, `renav-parse-isconnected-uaf`, `bbc-script-deliverable-uaf` | Vi phạm hợp đồng cancel-on-nav (mục 2) |
| Arena leak | `link-preload-arena-leak`, `worker-deferred-script-and-image-arena` | Xem mục 3 |
| Race lúc renavigate | `renavigate-cdp-reentrant-race`, `renav-cleanslate-parser-resource-defer`, `tinhte-renavigate-lifecycle-races`, `cancel-on-nav-ownership` | Realm cũ vs mới chồng chéo |
| iframe lifecycle | `iframe-unload-visibilitychange-lifecycle`, `iframe-named-access-unload-contentdocument`, `window-keys-prune-wipes-site-globals` | Sự kiện unload/visibility trong iframe con |
| Realm/scheduler | `realm-scheduler-suppressed-teardown`, `spa-classic-script-microtask-reentry`, `spa-document-currentscript-next-turbopack` | Xem `RealmLifecycleKernel` + `EventLoop.zig` |
| CDP hang | `ebay-empty-document-cdp-navigate-hang`, `navigate-non2xx-cdp-hang`, `mcp-goto-runner-deferred-parse` | Cùng họ với bug ở mục 7 (wait loop không hội tụ) |
| Network/curl | `amazon-aws-waf-hmac-import`, `sg-ss-curl-cli-cachelayer-null-conn`, `curl-slist-null-data-cdp-headers`, `cookies-json-source-secure-https-drop` | Tầng `HttpClient`/`Network`/curl |
| Fingerprint/anti-bot | `creepjs-*` (nhiều file), `grecaptcha-htmlelement-style-shim`, `bot-tampering-core-signals`, `fp-agent-worker-iframe-collection`, `fpjs-oss-parity-native-hooks`, `webgl1-version-probe-override` | Xem `src/runtime/profile/*Intelligent.zig` + `knowledge/fingerprint/` |
| WPT suite (chuẩn hoá) | `url-wpt-suite`, `wpt-async-error-handling-batch`, `wpt-cookie-suite`, `wpt-dom-suite`, `fetch-wpt-suite`, `google-signin-suite`, `websocket-wpt-suite`, `workers-wpt-suite` | Chạy qua external tree `~/Desktop/wpt-spa-tests`, xem `knowledge/architecture/wpt-spa-workflow.md` |
| Hiệu năng | `2026-07-23-lp-ports-gc-tick-dead-peer` (trong `knowledge/performance/`) | GC/tick liên quan tới MessagePort |

**Quy tắc**: trước khi kết luận "đây là bug mới", grep tên hiện tượng (panic reason, tên hàm, tên site) trong `knowledge/bugs/` và `knowledge/architecture/` — rất có thể đã có người gặp và ghi chép, kể cả khi chưa vá xong.

## 10. Bảng tra cứu nhanh khi gặp sự cố

| Triệu chứng | Bước đầu tiên |
|---|---|
| Crash lúc thoát, "ArenaPool leak" | Mục 3 |
| Crash `unreachable` | Cần lldb, mục 6 |
| Crash `incorrect alignment` | Mục 5 — race, đừng tin vào 1 lần log |
| Export/fetch chạy hết `--wait-ms` rồi trả về trang dở dang, KHÔNG crash | Mục 7 — nghi ngờ đầu tiên: busy-spin do `script_pending`/`network_idle` kẹt, dùng `--log-level debug --log-dir` |
| Panic không có stack trace hữu ích | Mục 6 — dùng lldb thay vì tin log mặc định |
| Build lỗi `NoSpaceLeft` | Mục 8 |
| Nghi ngờ site bị chặn bởi Cloudflare/anti-bot | ĐỪNG vội kết luận — kiểm tra network log trước, rất có thể là bug treo transfer (mục 7), không phải bị phát hiện |
