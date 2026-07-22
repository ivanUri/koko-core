# Replaced elements collapsed to 5×5 (img/iframe default object size)

> **Date:** 2026-07-22 · **Area:** Element layout, HTMLImageElement · **Status:** Core fix landed

## Summary

Unsized replaced elements (`img`, and previously only partially `iframe`) used Velora’s internal layout sentinel **5×5** instead of the CSS **default object size 300×150**. SPA image loaders that measure boxes / fire IntersectionObserver before setting `src` saw a collapsed rectangle; challenge iframes were similarly unusable for hit-testing. Layout now applies the CSS default object size for `img`, `iframe`, `video`, `embed`, and `object` when no CSS/attribute/intrinsic size is available. `HTMLImageElement.naturalWidth/Height` report non-zero values after a successful load (attribute or 300×150 fallback) instead of always `0`.

## Problem

On `https://www.nike.com/vn/` (and any site that mounts responsive images without immediate `src`):

- SSR emits `<img data-landscape-url=… data-portrait-url=… loading=eager>` **without** `src`.
- Client code is expected to pick a URL after layout / intersection.
- Velora reported `getBoundingClientRect()` **5×5** for those images.
- Export HTML therefore had **0** images with a real `src`.

Same 5px sentinel previously broke unsized captcha iframes (mitigated only for `iframe`).

## Root Cause

`Element` layout used `layout_default_size = 5` as “unknown”. For `iframe`, a special case applied HTML/CSS defaults **300×150**. For `img` (and other replaced tags), the 5px sentinel remained.

CSS 2.1 / CSS Images: the **default object size** for replaced content without a usable size is a **300×150** rectangle—not 5×5.

Separately, `Image.getNaturalWidth/Height` always returned `0`, so even after a successful network load, scripts that gate on `naturalWidth > 0` treated the image as empty.

## Solution

### `Element.zig`

- Rename conceptual constant to `replaced_default_width/height` (300×150).
- Apply to **`img`, `iframe`, `video`, `embed`, `object`** in all dimension resolution paths when width/height remain the 5px sentinel after CSS/attributes.

### `Image.zig`

- Track `_natural_width` / `_natural_height`.
- On successful load: set from width/height attributes, else **300×150**.
- `complete` with a non-empty `src` requires finished load (`_complete && !_loading`).

### Fixture

`code-check/fixtures/event-loop/el-p-img-default-object-size.html` — bare `<img>` and `<iframe>` must report 300×150.

## Follow-up (not fixed here)

Nike still hits **React minified error #423** during client hydration (~5s), then shows “Application error: a client-side exception has occurred” and tears down the tree (images go to zero). That is a separate hydration/runtime failure, not the default-object-size bug. Layout unit check after this fix: bare img/iframe **300×150**; Nike hero rects briefly **300×150** before the React crash.

## Lessons Learned

1. Internal layout sentinels must not leak into web-facing geometry for replaced elements.
2. Prefer CSS/HTML default object size (300×150) over fingerprint-era “tiny box” placeholders for `img`/`iframe`.
3. `naturalWidth === 0` after “successful” load breaks real SPA image pipelines as much as collapsed boxes do.
