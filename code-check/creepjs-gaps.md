# Velora gaps observed via CreepJS

Gap list rút ra từ `code-check/tmp/creepjs/creepjs.log` khi chạy
`node code-check/creepjs-check.js` đối với <https://abrahamjuliot.github.io/creepjs/>.

Priority xếp theo **tần suất API được dùng trên web thực** (P0 = phổ biến rộng,
P1 = phổ biến ở mảng app cụ thể, P2 = chuyên biệt / hiếm). Không phản ánh mức
độ chặn riêng của CreepJS.

## Trạng thái hiện tại (cập nhật)

- **totalLies**: 26 → **4** (chỉ còn worker errors, xem P1 Workers).
- **Tests passing**: window, html element, computed style, css media, screen, math,
  console errors, timezone, media, fonts, intl, rects, svg, resistance, canvas 2d,
  navigator, headless, features, loose fingerprint, stable fingerprint.
- **Tests still failing**: audio (P2), webgl (P1), speech (P2).
- **Đã fix** (P0):
  - IDL accessor descriptors cho `Navigator.*`, `Screen.*`, `Document.referrer`,
    `FontFace.status` (chuyển từ `bridge.property` sang `bridge.attribute`/`bridge.accessor`).
  - `matchMedia` evaluator thực (`MediaQueryEval.zig`) — đánh giá đúng query thay vì
    luôn trả false.
  - `CanvasRenderingContext2D.measureText` + `TextMetrics` interface.
  - `PluginArray` iterable (`Symbol.iterator`).
  - `Window.{innerWidth/innerHeight/outerWidth/outerHeight/devicePixelRatio/isSecureContext}`
    đổi sang accessor-style attribute.
  - `CanvasRenderingContext2D.font` / `OffscreenCanvasRenderingContext2D.font` thành
    accessor có instance state thật.
  - User-Agent bao gồm OS family (giữ brand "Velora/1.0" trung thực, sửa được lie
    "Apple platform and Other user agent do not match").

Mỗi entry có dạng:

- **priority**
- **evidence**: trích từ `creepjs.log`
- **creepjs test impacted**: tên test bị fail / lie
- **web usage note**: vì sao xếp priority này

---

## P0 — phổ biến rộng, gặp trên hầu hết site

### `CanvasRenderingContext2D.measureText` (+ `TextMetrics`)
- priority: **P0**
- evidence: `TypeError: context.measureText is not a function` tại `creep.js:3313` → `getCanvas2d`
- creepjs test impacted: `- canvas 2d failed`
- web usage note: dùng ở mọi thư viện vẽ chữ / charting / layout (Chart.js, D3,
  ProseMirror, code editor đo char-width). Thiếu là vỡ vô số trang.

### `matchMedia` (đầy đủ `MediaQueryList`: `matches`, `media`, `addEventListener`, `change` event)
- priority: **P0**
- evidence: lies probe → `Screen: 0: failed matchMedia`
- creepjs test impacted: lie `Screen` + nhánh CSS media probe
- web usage note: responsive design, dark-mode, prefers-reduced-motion — có ở
  gần như mọi site hiện đại.

### `Object.getOwnPropertyDescriptor(<IDL prototype>, '<prop>')` trả đúng `{get, set, configurable, enumerable}`
- priority: **P0**
- evidence: 20 dòng `0: failed descriptor.value undefined` cho
  `Navigator.{userAgent, appCodeName, appName, appVersion, language, deviceMemory,
  hardwareConcurrency, maxTouchPoints, product, vendor, webdriver}`,
  `Screen.{availHeight, availWidth, colorDepth, height, pixelDepth, width}`,
  `Document.referrer`, `FontFace.status`, `CanvasRenderingContext2D.font`,
  `OffscreenCanvasRenderingContext2D.font`.
- creepjs test impacted: `lies: 26 (totalLies)` — phần lớn là descriptor lies
- web usage note: feature-detect / polyfill (core-js, modernizr, framework
  internals) đọc descriptor liên tục. Hiện trả `value: undefined` thay vì
  `{get: nativeFn}` → mọi getter-based detect đều sai.

### `navigator.plugins` iterable (`PluginArray` với `length`, `[Symbol.iterator]`, indexed)
- priority: **P0**
- evidence: `TypeError: plugins is not iterable` tại `creep.js:6296` → `getNavigator`
- creepjs test impacted: `[plugins failed]`
- web usage note: nhiều legacy lib và bot-detection script `for (const p of
  navigator.plugins)` hoặc `Array.from(navigator.plugins)`.

### `Element.getClientRects` / `getBoundingClientRect` chính xác cho rotated/transformed elements
- priority: **P0**
- evidence: lies →
  `Element.getClientRects: equal elements mismatch / unknown rotate dimensions /
  unknown ghost dimensions`
- creepjs test impacted: lie `Element.getClientRects` (3 sub-lies)
- web usage note: modal, tooltip, drag&drop, virtualized list, FLIP animation
  — nhiều framework UI phụ thuộc.

---

## P1 — phổ biến ở mảng ứng dụng cụ thể

### Web Worker `self.navigator.*` (`userAgent`, `platform`, `hardwareConcurrency`, `deviceMemory`, `language(s)`, `plugins`)
- priority: **P1**
- evidence: trong worker `creep.js:171` throw `invalid argument`, sau đó:
  `Cannot read properties of undefined (reading 'platform')` @ `getNavigator:6120`,
  `... 'userAgent'` @ `:6150`,
  `... 'deviceMemory'` @ `:6181`,
  `... 'hardwareConcurrency'` @ `:6251`,
  `plugins is not iterable` @ `:6296`
- creepjs test impacted: nhánh worker fingerprint sụp đổ hoàn toàn (`worker
  script error`)
- web usage note: PDF.js, sql.js, image processing, web-worker-based libs —
  app medium/heavy thường có. App đơn giản không đụng.
- ghi chú: fix cái này thì error `creep.js:171 invalid argument` cũng tự hết.

### WebGL (`getContext('webgl'|'webgl2')` non-null + API tối thiểu)
- priority: **P1**
- evidence: `- webgl failed`
- creepjs test impacted: `webgl`
- web usage note: bắt buộc cho game, 3D, Mapbox/Google Maps GL, nhiều quảng
  cáo dùng để fingerprint. Nhiều site fallback nếu không có, nhưng feature gate
  rất phổ biến.

### `navigator.{maxTouchPoints, language, languages, vendor, product, appName, appCodeName, appVersion, webdriver}` qua getter native
- priority: **P1**
- evidence: descriptor.value undefined (xem P0) — đã liệt kê ở P0 phần descriptor
- creepjs test impacted: navigator lies + `getNavigator` attempts fail
- web usage note: i18n, touch-detect, bot-detect khắp nơi. Đọc trực tiếp
  `navigator.x` thường ổn (?) nhưng descriptor-based detect vỡ — overlap với P0
  nhưng cũng cần value đúng, không chỉ descriptor.

### `Screen.{availWidth, availHeight, width, height, colorDepth, pixelDepth}` getter native
- priority: **P1**
- evidence: descriptor.value undefined (xem P0)
- creepjs test impacted: screen lies
- web usage note: responsive layout JS, ad networks, analytics.

### `Document.referrer` getter native
- priority: **P1**
- evidence: descriptor.value undefined cho `Document.referrer`
- creepjs test impacted: lie `Document.referrer`
- web usage note: analytics, affiliate, anti-clickjacking — gần như mọi
  marketing site đọc.

### `FontFace.status` + Font Loading API (`document.fonts.ready`, `document.fonts.check`)
- priority: **P1** (xếp lên từ P2 vì web font có ở rất nhiều site)
- evidence: descriptor.value undefined `FontFace.status`
- creepjs test impacted: lie `FontFace.status`
- web usage note: bất cứ trang dùng custom font + chờ font load (Material UI,
  Tailwind + Google Fonts, …).

---

## P2 — chuyên biệt, ít gặp hơn

### `AudioContext` / `OfflineAudioContext`
- priority: **P2**
- evidence: `- audio failed`
- creepjs test impacted: `audio`
- web usage note: audio app, một số fingerprint lib. App thường không dùng.

### `SpeechSynthesis` / `SpeechRecognition`
- priority: **P2**
- evidence: `- speech failed`
- creepjs test impacted: `speech`
- web usage note: rất hiếm (accessibility / voice app).

### `OffscreenCanvas` + `OffscreenCanvasRenderingContext2D`
- priority: **P2**
- evidence: descriptor.value undefined `OffscreenCanvasRenderingContext2D.font`
- creepjs test impacted: lie `OffscreenCanvasRenderingContext2D.font`
- web usage note: chủ yếu web worker rendering / canvas-heavy app.

### WebRTC (`RTCPeerConnection`, `navigator.mediaDevices`)
- priority: **P2** (giữ nguyên "blocked" nếu chủ đích)
- evidence: render DOM → `host connection: blocked`, `stun connection: blocked`,
  `sdp capabilities: blocked`, `devices (0): blocked`
- creepjs test impacted: WebRTC section toàn `blocked`
- web usage note: video call (Meet, Zoom web), chat. Bị block hợp lý cho
  privacy.

---

## Ghi chú thêm

- `Window.devicePixelRatio` bị flag `lied dpr` — có thể do mismatch giữa giá
  trị navigator-side và screen-side; xem lại khi fix descriptor (P0) + Screen
  (P1).
- `Navigator.platform` lie: `"Apple platform and Other user agent do not match"`
  — UA report `Velora/1.0` trong khi `platform = MacIntel`. Nếu muốn giảm lie,
  để platform khớp UA (hoặc đổi UA chứa Mac/Linux/Windows tương ứng host).
- 131 API analyzed, 20 corrupted — tỉ lệ ~15%, gần hết là descriptor lies (P0).
  Fix P0 descriptor xong số "corrupted" sẽ tụt mạnh.

## Thứ tự fix đề xuất

1. P0 descriptor.get cho IDL attributes (Navigator/Screen/Document/FontFace/Canvas).
2. P0 `measureText` + TextMetrics.
3. P0 `matchMedia` đầy đủ.
4. P0 `navigator.plugins` iterable.
5. P0 `getClientRects` precision.
6. P1 Worker `self.navigator.*` (kéo theo fix `creep.js:171`).
7. P1 WebGL minimal context.
8. P2 còn lại theo nhu cầu.
