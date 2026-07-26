# Build & Dependencies Map

Tài liệu này mô tả toàn bộ hệ thống build của Velora (`build.zig`, ~52KB /
1262 dòng, `build.zig.zon`, `Makefile`, `Dockerfile`) để một phiên AI coding
trong tương lai không cần đọc lại toàn bộ `build.zig` mỗi lần. Velora là một
headless browser engine viết bằng Zig (~178K LOC), hướng tới automation/AI
(xem `README.md`, `AGENTS.md`).

Nguồn: `build.zig`, `build.zig.zon`, `Makefile`, `Dockerfile`,
`docs/homebrew.md`, `docs/tls-impersonate.md`, `docs/curl-impersonate-fork.md`,
`vendor/`, `packaging/`, `vendor/v8-wrapper/build.zig` (dependency con dùng
để build V8).

---

## 1. Cách build — Makefile targets vs `zig build` trần

### Sự khác biệt cốt lõi

- **`zig build` trần** (không qua Makefile) build ở optimize mode mặc định
  là **Debug**, và **không** tự tạo V8 snapshot trước — nếu không truyền
  `-Dsnapshot_path`, `opts.snapshot_path` sẽ là `null` (velora runtime tự xử
  lý trường hợp thiếu snapshot, xem `src/main_snapshot_creator.zig` /
  runtime dùng snapshot làm gì thì ngoài phạm vi file build.zig).
- **Makefile `build`** luôn build ở **ReleaseFast** và luôn build V8 snapshot
  trước (dependency `build-v8-snapshot`), rồi truyền
  `-Dsnapshot_path=../../snapshot.bin` vào lần build chính. Đây là con đường
  "production-like" — nhanh hơn ở runtime (JIT/snapshot warm-start) nhưng
  build lâu hơn và không có debug info hữu ích (xem mục 8 — binaries luôn bị
  strip).
- **Makefile `build-dev`** chỉ chạy `zig build` trần (Debug mode, không có
  bước snapshot riêng) — dùng khi lặp code nhanh, không cần perf tối ưu.

### Bảng targets đầy đủ (đọc toàn bộ Makefile)

| Target | Lệnh thực thi | Mục đích / khi dùng |
|---|---|---|
| `help` | In danh sách target từ comment `## ...` trong Makefile | Xem nhanh các lệnh có sẵn |
| `build-v8-snapshot` | `zig build -Doptimize=ReleaseFast snapshot_creator -- src/snapshot.bin` | Sinh file `src/snapshot.bin` (V8 heap snapshot) ở chế độ ReleaseFast. Là dependency của `build`. |
| `build` | phụ thuộc `build-v8-snapshot`, sau đó `zig build -Doptimize=ReleaseFast -Dsnapshot_path=../../snapshot.bin` | Build production/release đầy đủ, có snapshot. Dùng khi cần benchmark hoặc phát hành. |
| `build-dev` | `zig build` (Debug, mặc định) | Build nhanh cho vòng lặp phát triển; **không** build snapshot riêng. |
| `run` | phụ thuộc `build`, sau đó chạy `./zig-out/bin/velora` | Chạy bản ReleaseFast đã build. |
| `run-debug` | phụ thuộc `build-dev`, sau đó chạy `./zig-out/bin/velora` | Chạy bản Debug đã build. |
| `test` | `TEST_FILTER="$F" zig build test -freference-trace`, chạy qua `script` để giữ TTY và `grep -v` lọc bỏ dòng lệnh compile khổng lồ | Chạy unit test. Hỗ trợ filter qua `make test F="server"`. |
| `bench` | phụ thuộc `build`, rồi `npm run bench:compare:publish` | So sánh hiệu năng Velora vs Chromium (cần preflight ReleaseFast). |
| `end2end` | yêu cầu thư mục `../demo` tồn tại, chạy `go run runner/main.go` trong đó | Test end-to-end qua repo `demo` runner viết bằng Go (external, sibling repo). |
| `install` | phụ thuộc `build` | Alias build cho "install" workflow. |
| `data` | `cd src/data && go run public_suffix_list_gen.go > public_suffix_list.zig` | Sinh lại file Zig danh sách public suffix (dùng Go, không phải Zig, chạy thủ công khi cần cập nhật). |

Ghi chú: Makefile tự phát hiện OS/ARCH qua `uname -ms` (macOS arm64/x86_64,
Linux aarch64/x86_64) chỉ để chọn nhánh `test` (dùng `script -q /dev/null`
trên macOS vs `script -qec ... /dev/null` trên Linux — khác biệt cú pháp của
lệnh `script` giữa hai hệ).

---

## 2. `build.zig` options — mọi lời gọi `b.option(...)`

Bảng đầy đủ các cờ dòng lệnh (`-D<flag>`) được định nghĩa trực tiếp trong
`build.zig` (không tính các option nội bộ của dependency `v8` như `is_asan`,
`is_tsan`, `symbol_level`, `v8_enable_sandbox`, `cache_root`, những cờ này
được `build.zig` forward xuống dependency `v8` qua `b.dependency("v8", .{...})`
chứ không phải cờ độc lập của repo chính, xem mục 4a).

| Flag | Kiểu | Default | Ý nghĩa |
|---|---|---|---|
| `-Dprebuilt_v8_path` | `?[]const u8` | `null` | Đường dẫn tới file `libc_v8.a` đã build sẵn. Khi set, `linkV8` bỏ qua toàn bộ bootstrap depot_tools/V8 nguồn và chỉ link thẳng archive này (dùng trong CI / Dockerfile để tránh build V8 from source). |
| `-Dsnapshot_path` | `?[]const u8` | `null` | Đường dẫn tới file V8 snapshot (`.bin`) để nhúng vào runtime; forward vào `build_config` module qua `opts.addOption`. |
| `-Dversion` | `[]const u8` | (đọc từ `build.zig.zon`) | Override version string, xử lý trong `resolveVersion()` (mục 6). |
| `-Dstrip` | `bool` | `true` | Có strip debug symbol khỏi binary `velora` hay không. **Mặc định true kể cả ở Debug** — đây là workaround cho bug compiler Zig 0.15.2 (mục 8). |
| `-Dtsan` | `bool` | `false` | Bật Thread Sanitizer (`sanitize_thread`) cho velora module, curl, zlib, nghttp2, libidn2, usrsctp, v.v. Cũng forward `is_tsan=true` vào dependency V8 (ảnh hưởng `v8_enable_sandbox` — xem `linkV8`: `.v8_enable_sandbox = is_tsan`). |
| `-Dasan` | `bool` | `false` | Bật Address Sanitizer, chỉ forward vào dependency V8 (`is_asan`) — không thấy áp `sanitize_c`/riêng cho velora module trong `build.zig` chính. |
| `-Dcsan` | `?std.zig.SanitizeC` | `null` | Bật C Sanitizer (enum kiểu Zig), áp dụng cho velora module, sqlite lib, legacy_test exe, main exe. |
| (option chuẩn Zig) `-Dtarget` | target | host | Chuẩn `b.standardTargetOptions`. |
| (option chuẩn Zig) `-Doptimize` | enum | `Debug` | Chuẩn `b.standardOptimizeOption`. Debug / ReleaseSafe / ReleaseFast / ReleaseSmall. |

Các option riêng của dependency `v8` (đặt qua `vendor/v8-wrapper/build.zig`,
không phải cờ của repo chính nhưng đáng biết vì thường bị nhầm là cờ của
`build.zig` gốc):

| Flag (trong v8-wrapper) | Ý nghĩa |
|---|---|
| `-Dis_asan` | Bật ASan khi build V8 core (GN arg `is_asan`). |
| `-Dis_tsan` | Bật TSan khi build V8 core. |
| `-Dv8_enable_sandbox` | Bật V8 sandbox (mặc định set = `is_tsan` từ build.zig gốc). |
| `-Dsymbol_level` | Mức symbol GN (`0` release / `1` debug mặc định). |
| `-Dcache_root` | Thư mục cache cho depot_tools + V8 nguồn (build.zig gốc luôn truyền `.velora-cache`). |
| `-Dprebuilt_v8_path` | (trùng tên, được build.zig gốc forward) bỏ qua bootstrap hoàn toàn. |
| `-Dinspector_subtype` | Có export `valueSubtype`/`descriptionForValueSubtype` cho V8 inspector hay không (build.zig gốc luôn set `false`). |

---

## 3. Build targets (executable/library) mà `build.zig` định nghĩa

`build.zig` định nghĩa một module chung `velora_module` (từ
`src/velora.zig`) rồi build nhiều artifact khác nhau dùng chung module đó:

1. **Module `velora`** (`b.addModule("velora", ...)`) — root source
   `src/velora.zig`, `link_libc = true`, `link_libcpp = true` (do có C++ như
   V8 binding). Tự import chính nó dưới tên `"velora"` để cho phép circular
   import, và import module `build_config` (chứa `version`,
   `version_encoded`, `snapshot_path`, `curl_impersonate` — cờ bool cho biết
   máy hiện tại có sẵn artifact curl-impersonate hay không).
2. **`fmt` step** — `b.addFmt` check format trên `src`, `build.zig`,
   `build.zig.zon` (`.check = true`, không tự sửa). Được gắn vào
   `b.default_step` — nghĩa là **`zig build` trần luôn chạy fmt check trước
   mọi thứ khác**, build sẽ fail nếu code chưa format.
3. **`check` step** (`zig build check`) — build thử các `addLibrary` (không
   sinh binary cài đặt) cho: `velora_check` (chính module velora),
   `velora_exe_check` (root module của exe `velora`),
   `snapshot_creator_check`, `legacy_test_check`. Dùng để có typecheck nhanh
   (LSP-style) mà không phải link full binary — hữu ích cho CI hoặc kiểm tra
   nhanh lỗi biên dịch.
4. **Executable `velora`** (`src/adapters/cli/main.zig`) — binary chính, cài
   vào `zig-out/bin/velora` qua `b.installArtifact(exe)`. Luôn dùng
   `use_llvm = true` và `strip = strip_binaries` (mặc định true — mục 8).
   Có step `run` (`zig build run -- <args>`) và step `version`
   (`zig build version`, chạy `velora version`).
5. **Extras step** (`zig build extras`) — **tắt khỏi default install** để
   tránh phải compile 3 executable mỗi lần sửa code (comment trong file:
   "Extras (snapshot_creator, legacy_test) are off the default install to
   avoid paying for three exe compiles on every edit"). Gồm:
   - **`velora-snapshot-creator`** (`src/main_snapshot_creator.zig`) — sinh
     V8 heap snapshot. Có step riêng `snapshot_creator`
     (`zig build snapshot_creator -- <output.bin>`) — đây là step mà
     Makefile `build-v8-snapshot` gọi.
   - **`legacy_test`** (`src/main_legacy_test.zig`) — executable test kiểu
     cũ, có step chạy riêng `legacy_test`.
6. **`test` step** (`zig build test`) — `b.addTest` trên `velora_module`,
   dùng test runner tùy chỉnh `src/testing/test_runner.zig` (mode
   `.simple`), chạy qua `run_tests`.

Tóm tắt sơ đồ phụ thuộc: `velora_module` → dùng chung bởi `velora` exe,
`velora-snapshot-creator` exe, `legacy_test` exe, và `test` binary. Mỗi
target cũng có một `*_check` library tương ứng gắn vào step `check` tổng.

---

## 4. Dependencies bên ngoài và cách link

### 4a. V8 (JS engine) — `linkV8()`

`linkV8` không tự build V8; nó gọi `b.dependency("v8", .{...})` trỏ tới
`vendor/v8-wrapper` (một build.zig con, xem `build.zig.zon`:
`.v8 = .{ .path = "vendor/v8-wrapper" }`). Wrapper này mới thực sự chứa toàn
bộ logic bootstrap/build V8.

Cơ chế cache hai tầng trong `vendor/v8-wrapper/build.zig`:

- `cache_root` mặc định `.lp-cache`, nhưng `build.zig` gốc luôn override
  bằng `b.pathFromRoot(".velora-cache")` → mọi artifact V8 nằm dưới
  `.velora-cache/v8-14.0.365.4/` và `.velora-cache/depot_tools-14.0.365.4/`
  (version hiện tại `V8_VERSION = "14.0.365.4"` — hardcode trong
  `vendor/v8-wrapper/build.zig`).
- **`bootstrapDepotTools`**: kiểm tra marker file
  `.velora-cache/depot_tools-<ver>/.bootstrap-complete`. Nếu tồn tại → in
  `"Using cached depot_tools bootstrap from ..."` và bỏ qua toàn bộ bước
  copy + `ensure_bootstrap`. Nếu không → copy toàn bộ depot_tools dependency
  vào cache dir và chạy `ensure_bootstrap`, việc này chậm (tải nhiều công
  cụ Google: gn, ninja/siso, clang, gclient…).
- **`bootstrapV8`**: tương tự có marker `.bootstrap-complete` trong
  `v8-<ver>/`, nhưng còn so sánh mtime các "staged files" (shim
  `binding.cpp`, `inspector.h`, `BUILD.gn`, `.gn` — copy từ
  `vendor/v8-wrapper/src` và `build-tools/`) với thư mục V8 đã bootstrap. Nếu
  bất kỳ file nào mới hơn → in `"Source file ... changed, updating
  bootstrap"` và re-sync. Nếu không có gì đổi → in `"Using cached V8
  bootstrap from ..."`.
- **`buildV8`**: build thật sự (GN `gen` + `autoninja -C <out_dir> c_v8`)
  chỉ chạy khi `needs_build` = true, tức khi: (a) bootstrap cần cập nhật,
  hoặc (b) output `libc_v8.a` của out_dir tương ứng (hash theo GN args:
  `is_debug`, `is_asan`, `is_tsan`, `v8_enable_sandbox`, `symbol_level`...)
  chưa tồn tại hoặc cũ hơn staged files. Mỗi tổ hợp GN args khác nhau (vd.
  Debug vs ReleaseFast, tsan bật/tắt) sinh ra **thư mục output riêng**
  (`out/<os>/<debug|release>_<hash>`), nên đổi optimize mode hoặc bật
  `-Dtsan`/`-Dasan` lần đầu sẽ luôn kích hoạt một lần build V8 mới (tốn thời
  gian rất lâu — build V8 from source qua GN/ninja).
- **`-Dprebuilt_v8_path`** bỏ qua toàn bộ cơ chế trên: `linkV8` forward
  thẳng path này vào dependency, wrapper link file `.a` có sẵn (đây là con
  đường Dockerfile dùng — tải static lib `libc_v8.a` build sẵn từ GitHub
  release `zig-v8-fork`, không cần depot_tools/V8 source tại tất cả).

**Kích thước thực tế quan sát**: `.velora-cache/` ~**8.9GB** (gồm
`depot_tools-14.0.365.4/` và `v8-14.0.365.4/` — chứa toàn bộ Chromium
depot_tools + V8 source tree + object files build). Đây không phải cache có
thể xóa tùy tiện (xem mục 7).

### 4b. curl-impersonate — `linkCurl()` / `linkCurlImpersonate()`

Là HTTP client giả lập TLS/JA3/JA4 fingerprint của Chrome thật (fork của
[lexiforest/curl-impersonate], hiện tại `v2.0.0rc3` / `curl 8.21.0-IMPERSONATE`
với BoringSSL + chữ ký ML-DSA cho Chrome 150 — xem `docs/tls-impersonate.md`,
`docs/curl-impersonate-fork.md`). Velora cần nó vì automation/AI browsing bị
Google và nhiều site khác chặn dựa trên TLS handshake fingerprint (JA3/JA4)
ngay cả khi HTTP headers/JS fingerprint đã khớp Chrome thật — `libcurl`
mặc định (không impersonate) sẽ có handshake khác biệt và bị chặn (`/sorry`
page).

Logic chọn nhánh trong `build.zig`:

- `hasCurlImpersonate(b, os)` kiểm tra file tồn tại thực tế
  (`fileExists`) — **không** phải một cờ build, mà tùy vào việc thư mục
  `vendor/curl-impersonate/` (macOS) hoặc
  `vendor/curl-impersonate/linux/` (Linux) đã có sẵn artifact hay chưa.
  - macOS: `vendor/curl-impersonate/libcurl-impersonate.a` hoặc `.dylib`.
  - Linux: `vendor/curl-impersonate/linux/libcurl-impersonate.so` hoặc `.a`.
  - Hai cây macOS/Linux **độc lập hoàn toàn** — có sẵn `.a` cho macOS không
    kích hoạt impersonate trên Linux và ngược lại.
- Nếu có → `linkCurlImpersonate()`: link **prebuilt binary** (ưu tiên
  dylib/so hơn static `.a` vì comment trong code: *"linking the 29MB static
  archive into the V8 exe can SIGSEGV Zig's linker"*), thêm include path
  vendor + include path của dependency `curl` gốc (chỉ lấy header, không
  build lại nguồn), link thêm `libidn2` (build từ source, xem 4f),
  `iconv`, `icucore`, framework `CoreFoundation`/`CoreServices`/
  `SystemConfiguration` (macOS) hoặc `pthread`/`dl`/`m` (Linux). Có thêm
  file C nguồn `vendor/curl-impersonate/curl_ws_stub.c` (macOS only, stub
  WebSocket).
- Nếu không có artifact impersonate (fallback, "non-impersonate build") →
  `buildCurl()`: build **libcurl chuẩn từ source** (dependency `.curl` trong
  `build.zig.zon`, hiện tại pin `curl-8.18.0`) bằng cách tự sinh
  `curl_config.h` qua `ConfigHeader` (hàng trăm macro `HAVE_*`/
  `CURL_DISABLE_*`, tắt hầu hết protocol không cần — FTP, LDAP, SMTP,
  TELNET, v.v — chỉ giữ HTTP(S)/WebSocket), compile toàn bộ `lib/*.c` của
  curl, rồi tự build và link thêm **zlib**, **brotli**, **nghttp2**,
  **BoringSSL** (qua dependency `boringssl-zig`), **libidn2** — tất cả từ
  source qua các hàm `buildZlib`/`buildBrotli`/`buildNghttp2`/`buildBoringSsl`/
  `buildLibidn2` bên dưới trong cùng file.

Trên macOS, cả 2 nhánh đều cần link framework `CoreFoundation` +
`SystemConfiguration` (proxy resolution qua macOS system APIs).

### 4c. html5ever (Rust HTML5 parser) — `linkHtml5Ever()`

`html5ever` là HTML5 parser chuẩn viết bằng Rust (dùng qua crate nội bộ
`litefetch-html5ever` tại `src/core/html5ever/`, có `Cargo.toml`, `lib.rs`,
`sink.rs`, `types.rs`, `Cargo.lock`). Velora dùng nó làm parser HTML tuân thủ
spec WHATWG thay vì tự viết parser HTML5 đầy đủ bằng Zig.

Cơ chế: `linkHtml5Ever` gọi **`cargo build`** thật sự như một
`b.addSystemCommand` bước con của `zig build`:

```
cargo build --profile <dev|release> --manifest-path src/core/html5ever/Cargo.toml
```

(`dev` profile nếu `optimize == .Debug`, ngược lại `release`). Đây là lý do
khi build lần đầu (hoặc sau khi sửa Rust source) sẽ thấy **output compile
Rust thật** trong quá trình `zig build` — các crate transitive: `libc`,
`siphasher`, `proc-macro2`, `tikv-jemalloc*`, `markup5ever`, `xml5ever`,
`html5ever`. Zig `addFileInput` được gọi thủ công cho từng file nguồn
(`Cargo.toml`, `Cargo.lock`, `lib.rs`, `sink.rs`, `types.rs`) — comment giải
thích: mặc định Zig chỉ key cache theo argv của `addSystemCommand`, nên nếu
không khai báo file input tường minh thì sửa code Rust sẽ **không** kích
hoạt rebuild cargo. Output dùng `--target-dir=html5ever` (output directory do
Zig quản lý), rồi link tĩnh file
`liblitefetch_html5ever.a` (`out_dir/<debug|release>/liblitefetch_html5ever.a`)
vào module qua `mod.addObjectFile`. Có step riêng `zig build html5ever`.

### 4d. WebRTC (usrsctp + BoringSSL) — `linkWebRtc()`

Dùng cho hỗ trợ `RTCPeerConnection`/ICE (WebRTC Web API). `linkWebRtc` build
**usrsctp** (userspace SCTP stack — cần cho DataChannel) từ source
(dependency `.usrsctp` trong `build.zig.zon`, tải từ GitHub
`sctplab/usrsctp` nhánh `master`), compile các file `netinet/sctp_*.c`,
`user_*.c` với macro `-D__Userspace__ -DSCTP_PROCESS_LEVEL_LOCKS
-DSCTP_SIMPLE_ALLOCATOR -DUSE_SCTP_SHA1`. Đồng thời tái sử dụng lại
**BoringSSL** (ssl+crypto, build lại qua `buildBoringSsl` — cùng artifact
dùng cho curl phía không-impersonate) cho DTLS transport của WebRTC.

Lưu ý: hàm tên `linkWebRtc` nhưng thực chất chỉ build phần transport SCTP +
DTLS (usrsctp + BoringSSL); phần "WebRTC" cấp cao hơn (ICE/SDP/PeerConnection
logic) nằm trong mã Zig của Velora (`src/`), không phải một thư viện WebRTC
đầy đủ (kiểu libwebrtc của Google) được vendor riêng.

### 4e. nghttp2 (HTTP/2) — `buildNghttp2()` / `linkNghttp2ForVelora()`

Thư viện HTTP/2 framing chuẩn. Build từ source (dependency `.nghttp2`, pin
`nghttp2-1.68.0` release tarball), tự sinh header version
(`nghttp2ver.h` qua `ConfigHeader` style cmake, override
`PACKAGE_VERSION=1.68.90`/`PACKAGE_VERSION_NUM=0x016890` — cao hơn version
gốc 1.68.0, có thể là giả version để một số check runtime pass). Compile các
file `nghttp2_*.c` + `sfparse.c` với macro `-DNGHTTP2_STATICLIB`. Có **hai
noi dùng**: (1) `buildNghttp2` được gọi lại bên trong `linkCurl` cho nhánh
build-curl-from-source (không impersonate) để libcurl có HTTP/2; (2)
`linkNghttp2ForVelora` build **một bản riêng** và link thẳng vào
`velora_module` — nghĩa là Velora dùng nghttp2 trực tiếp ở tầng Zig (không
chỉ qua curl), khả năng cho HTTP/2 server-side hoặc CDP/network layer riêng.

### 4f. zlib, sqlite, stb_image_write

- **zlib** (`linkZlibModule` / `buildZlib`) — build từ source (dependency
  `.zlib`, pin `zlib-1.3.2`), compile các file chuẩn
  (`deflate.c`, `inflate.c`, `gz*.c`, …) với macro `HAVE_SYS_TYPES_H` v.v.
  Link vào `velora_module` trực tiếp (nén/giải nén HTTP content-encoding,
  và cũng dùng lại bên trong `buildCurl`).
- **sqlite3** (`linkSqlite`) — dùng dependency package sẵn có
  `sqlite3` (từ `allyourcodebase/sqlite3` fork, pin theo commit, version
  hiển thị `3.51.0`), không tự compile source thủ công như các lib khác mà
  gọi thẳng `dep.artifact("sqlite3")`. Tùy biến qua ~30 `SQLITE_OMIT_*` /
  `SQLITE_DEFAULT_*` macro để cắt giảm tính năng không cần (JSON, autovacuum,
  authorization, load-extension, v.v — thu nhỏ binary/attack surface), giữ
  `SQLITE_THREADSAFE=1`. Dùng cho lưu trữ nội bộ (storage/telemetry runtime
  layer theo README).
- **stb_image_write** (`linkStbImageWrite`) — thư viện header-only C ghi ảnh
  (PNG/JPEG/BMP…), vendor trực tiếp 2 file
  `vendor/stb_image_write.h` + `vendor/stb_image_write_impl.c` (không qua
  `build.zig.zon` dependency — copy source tĩnh trong repo). Dùng cho tính
  năng screenshot/xuất ảnh của browser.

### 4g. macOS-specific: CoreGraphics/CoreText, canvas text

Khi `target.result.os.tag == .macos`, module chính link thêm framework
**CoreGraphics** và **CoreText** (`mod.linkFramework(...)`, tìm framework
qua `/System/Library/Frameworks`) và biên dịch file
`vendor/canvas_text_macos.c` — cầu nối C giữa Zig và CoreText API của macOS
để render text lên `<canvas>` (Canvas 2D text API cần font shaping thật, và
CoreText là API native nhanh nhất trên macOS thay vì tự vendor một text
shaping engine đa nền tảng).

### 4h. libidn2, brotli, boringssl-zig (dependency hỗ trợ)

- **libidn2** (`buildLibidn2`) — build từ source GNU libidn2
  (`libidn2-2.3.8`) để xử lý IDN (internationalized domain name,
  Punycode/UTS46) cho cả `curl` (non-impersonate) và `curl-impersonate`. Cần
  vendor sẵn một `config.h` viết tay (`vendor/libidn2/`) vì autoconf +
  gnulib của libidn2 quá phức tạp để tái tạo bằng Zig build system (comment
  giải thích rõ trong code — ~800 dòng macro `HAVE_*` từ gnulib-common.m4).
  Trên macOS còn tự vá thiếu symbol `strchrnul` (macOS < 15.4 không có) qua
  `vendor/libidn2/darwin/strchrnul.c`.
- **brotli** (`buildBrotli`) — nén Brotli cho content-encoding HTTP, chỉ
  build khi dùng nhánh `buildCurl` (curl from source); build 3 lib con
  `brotlicommon`/`brotlidec`/`brotlienc`.
- **boringssl-zig** (`buildBoringSsl`) — dependency Git
  (`Syndica/boringssl-zig`, pin theo commit) cung cấp BoringSSL (`ssl` +
  `crypto` artifact) cho TLS của libcurl-from-source và cho DTLS của WebRTC
  (mục 4d). `bundle_ubsan_rt = false` set để tránh nhân đôi UBSan runtime.

---

## 5. Khác biệt nền tảng (macOS vs Linux) trong `build.zig`

| Khía cạnh | macOS | Linux |
|---|---|---|
| Text rendering | Link CoreGraphics/CoreText + `vendor/canvas_text_macos.c` | Không có nhánh tương đương trong `build.zig` (không thấy code fallback text-shaping riêng cho Linux trong file này). |
| V8 binding shims | Không cần | Nếu `vendor/v8_missing_shims.c` tồn tại (`fileExists` check), compile thêm vào module — bù các symbol mà bản V8 build/link trên Linux thiếu so với macOS (chỉ áp dụng "shims"; không ảnh hưởng build macOS/full V8 build). |
| curl-impersonate artifact path | `vendor/curl-impersonate/libcurl-impersonate.{a,dylib}` | `vendor/curl-impersonate/linux/libcurl-impersonate.{so,a}` — cây độc lập, tải riêng qua `scripts/fetch-linux-curl-impersonate.sh` (theo `docs/curl-impersonate-fork.md`) |
| curl-impersonate system libs | `iconv`, `icucore`, framework `CoreFoundation`/`CoreServices`/`SystemConfiguration` | `pthread`, `dl`, `m` |
| curl (non-impersonate) proxy support | Link `CoreFoundation` + `SystemConfiguration` framework (system proxy resolution API) | Không cần linking đặc biệt |
| V8 GN args (trong v8-wrapper) | Không có nhánh đặc biệt | `linux + aarch64`: thêm `clang_base_path="/usr/lib/llvm-21"`, `clang_use_chrome_plugins=false`, `treat_warnings_as_errors=false` (build.zig của `vendor/v8-wrapper`) |
| iOS (chỉ trong v8-wrapper GN args, chưa chắc dùng ở repo chính) | `v8_enable_pointer_compression=false`, `v8_enable_webassembly=false` khi target `.ios` | — |

---

## 6. `resolveVersion(b)` — cách tính version, dòng "Velora 1.0.2"

`build.zig` dòng đầu `build()` gọi `resolveVersion(b)` và in ra
`"Velora {version}\n"` — đây chính là dòng `"Velora 1.0.2"` xuất hiện ở đầu
mọi lần chạy `zig build`.

Logic:

1. Base version đọc trực tiếp từ `build.zig.zon` field `.version = "1.0.2"`
   (parse bằng `std.SemanticVersion.parse` ở top-level file, hằng
   `velora_version`).
2. Có thể override qua `-Dversion=<value>`:
   - Nếu `<value>` là semver hợp lệ đầy đủ (vd `2.0.0`) → thay thế hoàn toàn
     version gốc.
   - Nếu không phải semver hợp lệ (vd `nightly`) → chỉ thay phần
     **pre-release tag** của version gốc (giữ major.minor.patch, set
     `.pre = "nightly"`).
3. Nếu version có `pre` field nhưng **chưa có** `build` metadata (tức là một
   bản dev/nightly chưa được "làm giàu" thông tin git) → tự động thêm:
   - `pre = "<pre>.<commit_count>"` (số lượng commit từ `git rev-list --count HEAD`)
   - `build = "<short_hash>"` (từ `git rev-parse --short HEAD`)
   - Ví dụ dạng cuối: `1.0.0-dev.5243+dbe45229`.
4. Nếu version release chuẩn (không có `pre`) hoặc đã có `build` rồi → giữ
   nguyên, không đụng vào git.

`version_string` này được đưa vào module `build_config` (`opts.addOption`),
runtime Velora dùng để hiển thị qua lệnh `velora version` (step `zig build
version` chạy `exe -- version`). `version_encoded` chỉ là bản
`version_string` đã escape `+` thành `%2B` (để dùng an toàn trong URL, ví dụ
User-Agent hoặc endpoint version query).

---

## 7. CẢNH BÁO dung lượng đĩa: `.zig-cache/` vs `.velora-cache/`

Đây là mục **quan trọng** cần nhớ cho các phiên sau — có sự cố thực tế đã
xảy ra trong phiên làm việc này.

### `.zig-cache/` — cache compiler Zig, có thể xóa an toàn

- Là cache build tiêu chuẩn của Zig compiler (object files, incremental
  compilation state, LLVM IR cache, v.v). **Tự tái tạo hoàn toàn** khi build
  lại — không chứa artifact không thể lấy lại được.
- **Có thể phình rất lớn**: quan sát thực tế trong phiên này, `.zig-cache/`
  đã đạt tới **24GB** trên một đĩa gần đầy, gây lỗi build thật sự
  (`error: NoSpaceLeft` / hết dung lượng đĩa khi Zig cố ghi thêm object
  file).
- **Cách khắc phục đã áp dụng và xác nhận hiệu quả**: `rm -rf .zig-cache`
  rồi build lại. Cái giá phải trả là **compile lại từ đầu toàn bộ** (mất
  khoảng vài phút, không phải hàng giờ, vì phần build tốn thời gian nhất —
  V8, cargo, curl — nằm ở `.velora-cache/` và các dependency cache riêng của
  Zig package manager, không phải trong `.zig-cache/`).
- Khuyến nghị: nếu gặp lỗi hết dung lượng đĩa hoặc build bỗng chậm bất
  thường / lỗi lạ khó hiểu, **xóa `.zig-cache/` trước tiên** — an toàn, rẻ,
  và thường giải quyết được vấn đề.

### `.velora-cache/` — bootstrap V8 + depot_tools, KHÔNG xóa tùy tiện

- Chứa `depot_tools-<v8_version>/` và `v8-<v8_version>/` — toàn bộ cây công
  cụ Google (gn, ninja/siso, clang, gclient) **và** source tree V8 đã
  checkout + object file đã build.
- Kích thước quan sát thực tế: **~8.9GB**.
- Xóa cache này sẽ buộc lần build tiếp theo phải **re-fetch depot_tools từ
  đầu** (tải nhiều công cụ Google) **và re-checkout + rebuild toàn bộ V8 từ
  source** qua GN/ninja — quá trình này **chậm hơn nhiều bậc** so với
  compile lại Zig code (có thể mất hàng chục phút tới hơn một giờ tùy máy
  và băng thông mạng, vì đây gần như là build một phần Chromium).
- Chỉ nên xóa `.velora-cache/` khi thực sự cần (đổi V8 version, nghi ngờ
  cache hỏng, hoặc cố tình dọn dẹp có chủ đích) — **không** dùng nó như biện
  pháp "dọn đĩa nhanh" giống `.zig-cache/`.
- Đường tắt để tránh tốn `.velora-cache/` hoàn toàn: dùng
  `-Dprebuilt_v8_path=<path/to/libc_v8.a>` (con đường Dockerfile dùng — tải
  static lib build sẵn từ GitHub release, bỏ qua depot_tools/V8-from-source
  hoàn toàn).

**Tóm tắt quyết định nhanh**: hết đĩa hoặc build lỗi lạ → thử xóa
`.zig-cache/` trước (rẻ). Không bao giờ xóa `.velora-cache/` như bước xử lý
sự cố đầu tiên (đắt).

---

## 8. Bug compiler Zig 0.15.2 đã biết — vì sao luôn strip debug info

Comment trực tiếp trong `build.zig` (ngay tại định nghĩa executable `velora`,
gần option `strip`):

> `// Zig 0.15.2: LLVM+Debug SIGSEGV in lowerDebugType; native+Debug SIGSEGV`
> `// in updateLazySymbol.`
> `// Strip debug info in Debug builds to avoid LLVM debug-type recursion.`

Ý nghĩa: bản thân Zig compiler 0.15.2 có bug crash (SIGSEGV) khi cố sinh
debug type info cho các kiểu dữ liệu đệ quy/phức tạp trong build Debug — cả
hai backend (LLVM backend qua `lowerDebugType`, và backend "native"/self-hosted
qua `updateLazySymbol`) đều bị ảnh hưởng. Đây không phải bug của code Velora
mà là bug ở chính Zig toolchain 0.15.2.

**Workaround áp dụng**: cờ `-Dstrip` (mục 2) mặc định là `true` **ngay cả ở
Debug build**, khác với hành vi Zig chuẩn (thường Debug build giữ debug
info). Điều này tránh được đường code path gây SIGSEGV vì compiler không
cần sinh debug type info nữa.

**Hệ quả thực tế quan trọng cho debugging**: vì binary luôn bị strip, **panic
stack trace từ `crash_handler.zig` sẽ không bao giờ hiển thị thông tin dòng
code (file:line)** khi chạy local — kể cả build Debug. Chỉ có cách hữu ích
duy nhất để lấy thông tin backtrace chi tiết là dùng **lldb** đính kèm vào
binary (binary strip debug info nhưng vẫn còn symbol table ở mức hàm, không
strip hoàn toàn symbol) và chạy:

```
thread backtrace all
```

để lấy stack trace tất cả thread. Nếu cần debug sâu hơn (dòng code chính
xác), cân nhắc build tạm thời với `-Dstrip=false` để override, chấp nhận
rủi ro gặp lại SIGSEGV compiler bug nói trên đối với một số kiểu dữ liệu.

---

## 9. Dockerfile — mục đích và các bước

`Dockerfile` là build **multi-stage** (3 `FROM debian:stable-slim` liên
tiếp), dùng để tạo **container runtime image** để chạy Velora ở chế độ
server (`serve`), không phải để dev/test.

### Stage 0 — build stage (không đặt tên, `FROM debian:stable-slim`)

1. Cài dependency hệ thống: `xz-utils`, `ca-certificates`, `pkg-config`,
   `libglib2.0-dev`, `clang`, `make`, `curl`, `git`.
2. Cài **Rust toolchain** qua `rustup.rs` (profile minimal) — cần cho bước
   `cargo build` của html5ever (mục 4c).
3. Cài `minisign` (công cụ verify chữ ký) để xác thực tarball Zig tải về.
4. `git clone https://github.com/velora-io/browser.git` — **lưu ý: Dockerfile
   clone từ remote GitHub, không COPY code từ context build local** — nghĩa
   là build Docker image sẽ luôn lấy code mới nhất trên `main` của remote,
   không phải working tree hiện tại. (Điểm cần lưu ý nếu ai đó mong Docker
   build phản ánh local changes chưa push.)
5. Cài Zig: đọc version tối thiểu từ `build.zig.zon`
   (`grep '.minimum_zig_version = "'`), tải tarball chính thức từ
   `ziglang.org`, verify bằng `minisign` với public key hardcode
   (`ZIG_MINISIG` build arg), giải nén vào `/usr/local/lib`, symlink vào
   `/usr/local/bin/zig`. Chọn arch (`x86_64`/`aarch64`) theo
   `$TARGETPLATFORM` (hỗ trợ multi-arch Docker build).
6. Tải **V8 prebuilt** (`libc_v8.a`) từ GitHub release riêng của Velora
   (`velora-io/zig-v8-fork`, tag `ZIG_V8=v0.4.4`, ứng với `V8=14.0.365.4`) —
   đây chính là con đường `-Dprebuilt_v8_path` (mục 4a), **hoàn toàn bỏ qua
   depot_tools/V8-from-source** để build Docker image nhanh và không cần
   `.velora-cache` 8.9GB.
7. Build V8 snapshot: `zig build -Doptimize=ReleaseFast
   -Dprebuilt_v8_path=v8/libc_v8.a snapshot_creator -- src/snapshot.bin`.
8. Build release: `zig build -Doptimize=ReleaseFast
   -Dsnapshot_path=../../snapshot.bin -Dprebuilt_v8_path=v8/libc_v8.a`.

### Stage 1 — chỉ cài `tini` (process supervisor nhỏ gọn cho PID 1)

### Stage 2 (final runtime image)

- Copy CA certificates từ stage 0.
- Copy binary `velora` đã build từ stage 0 (`/browser/zig-out/bin/velora`
  → `/bin/velora`).
- Copy `tini` từ stage 1.
- `EXPOSE 9222/tcp` (cổng CDP mặc định, khớp README quick start).
- `ENTRYPOINT ["/usr/bin/tini", "--"]` — comment giải thích: Velora chỉ cài
  một số signal handler, và tiến trình PID 1 trong container không có
  default SIGTERM handler, nên dùng `tini` làm PID 1 để đảm bảo `docker
  stop` không bị treo.
- `CMD ["/bin/velora", "serve", "--host", "0.0.0.0", "--port", "9222",
  "--log-level", "info"]` — mặc định khởi động server CDP lắng nghe mọi
  interface.

Kết luận mục đích: Dockerfile phục vụ **build container runtime image** để
triển khai Velora như một service/server (không phải cho CI test hay dev
loop) — dùng prebuilt V8 để build nhanh, image cuối cùng tối giản (chỉ có
binary + tini + CA certs trên nền `debian:stable-slim`).

---

## 10. `packaging/` — nội dung và mục đích

```
packaging/
└── homebrew/
    └── velora.rb
```

Chỉ chứa **Homebrew formula** (`velora.rb`) cho việc phân phối Velora qua
Homebrew tap cá nhân (`ivanUri/homebrew-tap`, chưa lên `homebrew-core`) —
quy trình đầy đủ mô tả trong `docs/homebrew.md`.

Nội dung formula (`packaging/homebrew/velora.rb`):

- `license "AGPL-3.0-only"`, `version "1.0.2"`.
- `on_macos do on_arm do ... end end` — hiện tại **chỉ hỗ trợ macOS
  arm64**, tải tarball release
  `velora-1.0.2-darwin-arm64.tar.gz` từ GitHub Releases kèm `sha256`.
- `install`: copy `bin/velora` vào `bin`, mọi `lib/*.dylib` (chứa
  `libcurl-impersonate*.dylib` — TLS impersonation bundled sẵn, xem bảng
  "What the tarball contains" trong `docs/homebrew.md`) vào `lib`, và
  `share/velora/browser` (chứa profile JSON antidetect, templates, catalog)
  vào `share/velora`.
- `caveats`: hướng dẫn user nơi tìm `templates`/`catalog`, và lệnh khởi động
  server CDP.
- `test do`: chạy `velora --help` kiểm tra binary hoạt động.

Quy trình publish release (từ `docs/homebrew.md`, dành cho maintainer):

1. `zig build -Doptimize=ReleaseFast` rồi `./scripts/release-macos.sh
   1.0.0` trên từng kiến trúc macOS cần hỗ trợ → sinh
   `dist/velora-<ver>-darwin-<arch>.tar.gz` (script rewrite `@rpath` để
   binary tìm dylib dưới `../lib` trong Homebrew prefix).
2. `gh release create` để tạo GitHub Release kèm tarball.
3. Copy `packaging/homebrew/velora.rb` sang repo tap riêng
   (`ivanUri/homebrew-tap`), cập nhật `version`/`url`/`sha256`, commit +
   push.

Ghi chú quan trọng trong doc: **không** publish "source-only formula" vì
`zig build` phải tải V8 và quá lâu cho end user — luôn ship binary tarball
prebuilt.

---

## 11. Requirements tổng hợp (đối chiếu README.md)

Theo mục "Requirements" của `README.md`, khớp với những gì `build.zig`/
`Dockerfile` thực sự cần:

| Requirement | Vì sao cần | Ghi chú thêm từ build.zig |
|---|---|---|
| **Zig 0.15.2** | Toolchain build chính; `build.zig.zon` khai báo `.minimum_zig_version = "0.15.2"`, và `build.zig` tự `@compileError` nếu version Zig hiện tại thấp hơn (so sánh `builtin.zig_version` với `min_zig_version` ngay ở top-level, trước khi `build()` chạy). | Có bug compiler đã biết ở version này (mục 8) — không phải lỗi Velora. |
| **V8** | JS engine chạy trang web (thực thi script, DOM binding qua `vendor/v8-wrapper`) | Build from source (chậm, cache lớn) hoặc `-Dprebuilt_v8_path` (nhanh, dùng static lib build sẵn — cách Dockerfile dùng). |
| **libcurl** | HTTP(S)/HTTP2/WebSocket client tầng network | Mặc định ưu tiên `curl-impersonate` (fingerprint-aware) nếu có artifact vendor; nếu không, tự build libcurl chuẩn từ source kèm zlib/brotli/nghttp2/BoringSSL/libidn2. |
| **Rust toolchain** | Bắt buộc để `cargo build` crate `litefetch-html5ever` (HTML5 parser) trong quá trình `zig build` | Không có Rust toolchain → bước `linkHtml5Ever`/`cargo build` sẽ fail ngay từ đầu build. |
| **Node.js** | Cho TypeScript SDK (`velora-sdk`, repo riêng) và CLI helper npm script (`npm run bench:compare:publish` trong Makefile `bench` target) | Không phải dependency trực tiếp của `zig build`/`build.zig` — chỉ cần khi dùng SDK hoặc chạy benchmark qua npm. |

Requirement ẩn khác phát hiện được khi đọc `build.zig`/vendor mà README
không liệt kê tường minh nhưng cần cho một build từ-source đầy đủ (không
prebuilt): **Go toolchain** (dùng bởi `make data` để sinh
`public_suffix_list.zig`, và `make end2end` chạy `go run runner/main.go`
trong repo `demo` — cả hai đều ngoài phạm vi `zig build` chính nhưng nằm
trong Makefile).

---

## Tham chiếu nhanh các file liên quan

- `build.zig` — root build script chính (~1262 dòng), file nguồn của gần
  toàn bộ mô tả trên.
- `build.zig.zon` — khai báo version, fingerprint, dependency list (v8,
  brotli, zlib, nghttp2, boringssl-zig, curl, sqlite3, libidn2, usrsctp).
- `vendor/v8-wrapper/build.zig` — build script con thực sự bootstrap/build
  V8 (depot_tools, GN, ninja/siso).
- `Makefile` — wrapper tiện lợi quanh `zig build` cho dev workflow.
- `Dockerfile` — build container runtime image dùng prebuilt V8.
- `docs/homebrew.md`, `packaging/homebrew/velora.rb` — phân phối qua
  Homebrew.
- `docs/tls-impersonate.md`, `docs/curl-impersonate-fork.md` — bối cảnh vì
  sao cần curl-impersonate và cách vendor nó.
- `src/core/html5ever/` — crate Rust `litefetch-html5ever` được `cargo
  build` trong lúc `zig build`.
