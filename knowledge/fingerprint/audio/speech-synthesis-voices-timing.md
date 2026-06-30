# Speech Synthesis: Synchronous Remote Voices for CreepJS

## Summary

CreepJS **`voices`** failed when Velora deferred loading macOS **remote** speech voices by **3.5 seconds**. Chrome returns remote voices on the **first** `speechSynthesis.getVoices()` call that CreepJS snapshots (~800ms–2s after load). Loading remote voices **synchronously** inside `getVoices()` when a profile provides voice data restored hash parity (**`remoteLen=19`**, section **MATCH**).

The case illustrates a broader antidetect rule: **fingerprint probes read APIs once, early**—async lifecycle realism must not break first-call snapshots. Event timing (`voiceschanged` later) and getter completeness (what CreepJS hashes) are separate requirements.

---

## Problem

On profile `chrome-local-huys-macbook-pro`, CreepJS section compare reported `voices` hash mismatch vs Chrome:

- Velora under-reported **remote** voice count on the first probe pass
- Gate `voices local: 190` could pass while section hash still diverged
- `lies=0` — not a lie-detection failure

Field-level diff showed shorter voice list and missing remote entries compared to Chrome baseline in profile assets.

---

## Root Cause

### macOS voice model

On macOS, `speechSynthesis.getVoices()` returns:

- **Local voices** — available immediately
- **Remote voices** — system voices loaded from network/voice assets; Chrome includes them in the first synchronous enumeration when already cached

### Velora's delayed load

Velora initially scheduled `loadRemoteVoices` on a **3500ms** timer to mimic Chrome's delayed **`voiceschanged`** event (voices sometimes arrive after async system callback).

CreepJS captures `getVoices()` much earlier in its pipeline. The snapshot therefore saw **only local voices**, changing:

- Voice list length and ordering
- Section hash via `JSON.stringify`

The delay was a reasonable guess for **event timing** but wrong for **synchronous fingerprint reads**.

### Profile-driven antidetect

When `frame.loadedProfile().speech_voices` is populated, Velora should serve **deterministic profile data** on first getter—not emulate discovery latency that CreepJS never observes.

---

## Investigation

### Section compare

```bash
cd /Users/huydev/Desktop/velora
zig build install
node scripts/cdp-creepjs-section-compare.mjs \
  --profile chrome-local-huys-macbook-pro \
  --max-sec 20
```

`voices` listed under **MISMATCH** while `lies=0`.

### Field compare

```bash
node scripts/cdp-section-field-compare.mjs voices
```

(if extractor registered; otherwise compare voice list in section JSON under `code-check/tmp/creepjs-section-compare/`)

### Code trace

`src/core/webapi/speech/SpeechSynthesis.zig`:

- `getVoices()` → `loadLocalVoices(frame)` → `scheduleRemoteVoiceLoad` (3500ms delay) **before fix**

### Profile assets

`browser/profiles/assets/*-voices.json` — Chrome-captured local + remote voice entries bound through `ProfileStore`.

### CreepJS source

`code-check/sites/creep/creep.js` — voices section collects early synchronous `speechSynthesis.getVoices()`.

---

## Solution

In `SpeechSynthesis.getVoices()`, when `frame.loadedProfile().speech_voices` is non-empty:

1. **`loadLocalVoices(frame)`** — unchanged
2. **`loadRemoteVoices(frame)` immediately** — same implementation the delayed task used
3. **Keep delayed scheduling** only for fallback paths **without** profile voice data (closer to naive Chrome on unknown hardware)

### Code location

`src/core/webapi/speech/SpeechSynthesis.zig` — `getVoices()` synchronous remote load branch.

### Verification

- CreepJS compare lists `voices` under **matching** sections
- Gate `voices local: 190` unchanged
- `remoteLen=19` matches Chrome session baseline

### CreepJS voices fields (typical)

CreepJS hashes a structured object including voice **name**, **lang**, **localService**, **default**, and list **length**—not merely counts. A partial list shifts `JSON.stringify` output even when local count gates pass. Compare full objects in section compare JSON under `code-check/tmp/creepjs-section-compare/`, not summary logs alone.

### ProfileStore wiring

Voice arrays load from profile assets into `ProfileStore` (`speech_voices` or equivalent field on loaded profile). Ensure:

1. Asset captured from the **same Chrome build** as UA-CH (`uaFullVersion`).
2. Local and remote entries preserve **Chrome sort order** on first `getVoices()`.
3. `default` and `localService` booleans match Chrome for each entry—CreepJS includes them in the hash.

### Optional voiceschanged behavior

After synchronous `getVoices()` returns the full profile list, Velora may still dispatch `voiceschanged` on a timer for scripts that listen for updates. That path must **not clear or replace** the voice list with a smaller async snapshot on first event—some detectors call `getVoices()` twice and diff results.

### Broader antidetect pattern

| API | Wrong approach | CreepJS-safe approach |
|-----|----------------|----------------------|
| `getVoices()` | Delay remote voices 3.5s | Profile list on first call |
| `navigator.webgpu` | Async-only adapter info | Sync `adapter.info` when available |
| Font loading | Wait for `document.fonts.ready` only | Serve computed sizes CreepJS reads immediately |

### macOS-specific note

Remote voices on macOS correspond to system voices that may download on first use in a **real** user session. Velora's profile captures the post-download list Chrome returned during baseline capture. When refreshing voice assets, run Chrome on the same machine, call `speechSynthesis.getVoices()` once in DevTools after system voices have settled, then export into `browser/profiles/assets/*-voices.json`—do not hand-edit remote entries without a Chrome snapshot.

Related synchronous-read fix: [navigator WebGPU parity](../navigator/creepjs-navigator-parity.md) (`adapter.info` available on first probe).

Re-verify with `node scripts/cdp-creepjs-section-compare.mjs --profile chrome-local-huys-macbook-pro --max-sec 20` after any change to `SpeechSynthesis.zig`. Expect `voices` under matching sections when remote voices load synchronously.

---

## Lessons Learned

- **Fingerprint probes read APIs once, early**; deferring data breaks hashes even when “more realistic.”
- **Separate event timing from first getter completeness** — fire `voiceschanged` later if needed, but return full profile list on first `getVoices()`.
- **Profile-driven antidetect should prefer deterministic profile data** over async discovery emulation when the hash is synchronous.
- **Gates based on local voice count are insufficient** — remote voices affect hash too.
- **Same pattern applies elsewhere** — `navigator` GPU info, `getVoices`, font loading: ask when CreepJS reads, not when real Chrome finishes background work.

---

## References

- [Web Speech API — `getVoices()`](https://wicg.github.io/speech-api/#tts-getvoices-method)
- CreepJS: `code-check/sites/creep/creep.js` — voices section
- Velora: `src/core/webapi/speech/SpeechSynthesis.zig`
- Profile assets: `browser/profiles/assets/*-voices.json`
- Section compare: `scripts/cdp-creepjs-section-compare.mjs`
- Field compare: `scripts/cdp-section-field-compare.mjs`

---

## Related Knowledge

- [CreepJS navigator parity](../navigator/creepjs-navigator-parity.md) — synchronous navigator / WebGPU reads
- [CreepJS fonts parity](../fonts/creepjs-fonts-parity.md) — font load timing vs first hash
- [CreepJS probe 1680×1050 display](../creepjs-probe-1680-display.md) — harness consistency