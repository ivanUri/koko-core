# Input type=email: Selection, Backspace, and React Caret Clamp

> **Date:** 2026-07-22 · **Area:** HTMLInputElement, CDP Input, Fluent/React signup · **Status:** Core fixes verified (isolated probe)

## Summary

Automating `signup.live.com` (Hotmail register) stalled on step 1 because **Koko’s text-control model for `input[type=email]` was incomplete**:

1. **`select()` / `setSelectionRange` threw `InvalidStateError`** — `selectionAvailable` only listed text/search/url/tel/password (not email/number).
2. **`Backspace` did nothing** — `Frame.handleKeydown` never deleted characters.
3. **Caret jumped to 0 after React rewrote `.value`** — HTML/Chrome move selection to the **end** of the new value when the value IDL is set; Koko left a stale caret, so domain keystrokes landed *before* the local-part (`outlook.comstevenmiller…@`).

After the fixes, a plain `type=email` CDP probe passes insertText of a full address, select+replace, one-char Backspace, and React-style value rewrite with caret at end.

---

## Problem (Hotmail symptoms)

| Symptom | Cause layer |
|---------|-------------|
| `input.select()` fails on email field | **Core** — selection not available |
| Clear via Backspace no-op | **Core** — no delete path |
| `insertText("user@outlook.com")` then keys produce `outlook.comuser@` | **Core** — selection past EOF after React setValue |
| Fluent strips domain / multi-step “New email” | **Site + script** — product UI, not core sanitization |
| `getComputedStyle(::before)` warn spam | **Core** (noise) — now silent for known pseudos |

Isolated HTML (no React) already stored full emails via `Input.insertText`; `sanitizeValue` for email does **not** strip `@domain`.

---

## Root Cause

### selectionAvailable

```zig
// before
.text, .search, .url, .tel, .password => true
// after
+ .email, .number
```

Chromium treats email/number as text-control hosts. Without this, `howSelected()` always returns `.none`, so insert always appends and CDP “select all + insertText” cannot replace.

### Backspace

`handleKeydown` handled Enter and printable keys only. Added `innerDeleteBackward` / `innerDeleteForward` on `Input`.

### React caret / setValue selection

Fluent/React assigns `element.value = store` on every `input` event. Per HTML/Chrome, setting the value IDL attribute on a text control **moves selection to the end** of the new value. Koko only updated `_value` and left `selectionStart` at 0 (or past EOF), so the next keystroke inserted at the start.

Fix: `setValue` sets `_selection_start = _selection_end = new_len` for selection-available types.

### getComputedStyle(::before)

Still returns the host element’s computed style (same as before) but **no longer warns** for `::before` / `::after` / `::marker` (Fluent queries these constantly).

---

## Verification

```bash
cd /Users/huydev/Desktop/koko
zig build
# Isolated CDP probe (insert / select / replace / backspace / key)
# see session probe: type=email full address, caret after React rewrite
```

| Check | Result |
|-------|--------|
| insertText `user@outlook.com` | OK |
| `email.select()` no throw | OK |
| select + insertText replace | OK |
| Backspace one char (caret at end) | OK |
| key `c` after `ab` | OK |
| React rewrite caret stays end | OK |

---

## Files

- `src/core/webapi/element/html/Input.zig` — selectionAvailable, innerInsert caret, delete helpers, setValue clamp
- `src/core/browser/Frame.zig` — Backspace/Delete on keydown
- `src/core/webapi/Window.zig` — quiet pseudo getComputedStyle

## Not fixed here

- `realm.scheduler_suppressed` during navigation (noise / race; page often still loads)
- Fluent SPA multi-step “New email” → password (product flow; needs script + possibly form submit parity)
- GPA leak dumps on process exit (unrelated to input)
