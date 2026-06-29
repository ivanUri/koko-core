# Speech Synthesis: Synchronous Remote Voices for CreepJS

## Summary

CreepJS `voices` failed when Velora deferred loading macOS **remote** speech voices by 3.5 seconds. Chrome returns remote voices on the first `speechSynthesis.getVoices()` call that CreepJS snapshots. Loading remote voices synchronously inside `getVoices()` when a profile provides voice data restored hash parity (`remoteLen=19`, section **MATCH**).

---

## Problem

CreepJS `voices` section hash differed from Chrome on the `chrome-local-huys-macbook-pro` profile:

- Velora under-reported remote voice count on the first probe pass
- `voices local: 190` gate could pass while hash still diverged

---

## Root Cause

On macOS, `speechSynthesis.getVoices()` includes both **local** and **remote** voices. Chrome populates remote voices eagerly on first access (system voices loaded from the profile store).

Velora initially scheduled `loadRemoteVoices` on a **3500ms** timer to mimic Chrome's delayed `voiceschanged` event. CreepJS captures `getVoices()` much earlier (~800ms–2s). The snapshot therefore saw only local voices, changing the fingerprint hash.

The delay was a reasonable guess for event timing but wrong for **synchronous fingerprint reads**.

---

## Investigation

- CreepJS section compare flagged `voices` hash mismatch while `lies=0`.
- Compared voice list length and remote voice entries vs Chrome baseline in profile assets.
- Traced `SpeechSynthesis.getVoices()` → `scheduleRemoteVoiceLoad` delay.

---

## Solution

In `SpeechSynthesis.getVoices()`, when `frame.loadedProfile().speech_voices` is non-empty:

1. `loadLocalVoices(frame)` — unchanged
2. **`loadRemoteVoices(frame)` immediately** — same call that the delayed task used

Keep delayed scheduling only for fallback paths without profile voice data.

**Verification:** CreepJS compare lists `voices` under matching sections; gate `voices local: 190` unchanged.

---

## Lessons Learned

- Fingerprint probes read APIs **once, early**; lifecycle realism must not break first-call snapshots.
- Separate **event timing** (`voiceschanged` later) from **first getter completeness** (what CreepJS hashes).
- Profile-driven antidetect should prefer **deterministic profile data** over emulating async discovery when the hash is taken synchronously.

---

## References

- [Web Speech API — `getVoices()`](https://wicg.github.io/speech-api/#tts-getvoices-method)
- CreepJS voices section in `code-check/sites/creep/creep.js`
- Velora: `src/core/webapi/speech/SpeechSynthesis.zig`
- Profile assets: `browser/profiles/assets/*-voices.json`

---

## Related Knowledge

- None yet (navigator/window fingerprint notes may follow)