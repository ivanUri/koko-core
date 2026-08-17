# Controlled execution checkpoints

Koko Core supports **reconstructible** checkpoints. They restore browser state
in a new process; they are not V8 heap snapshots and cannot resume timers,
workers, in-flight promises, Cache Storage, or server-side session state.

## Create a checkpoint

Use **Inspect URL** in Koko Observatory. Its local bridge creates a private
directory per inspection, configures Core, and writes the telemetry stream.
The user never needs to choose an environment variable or filesystem path.

On completion (and on a fetch wait failure), Core writes these files:

- `cookies.json`
- `storage.json` — `localStorage` and `sessionStorage`, keyed by origin
- `manifest.json` — schema version, URL, state counts, and explicit limits

The manifest is written last, atomically, and is the checkpoint commit marker.
The directory contains credentials and must not be committed or shared.

## Restore and replay HTTP inputs

In Observatory, select a checkpoint in the replay rail and choose **Replay
selected checkpoint**. The bridge derives the strict policy from complete text
responses captured during that inspection and keeps the resulting file in its
private runtime directory.

`strict` is the default and fails each unmatched request with
`ExecutionReplayMiss`; it does not fall through to the Internet. Use
`"mode": "fallback"` only when live-network fallback is explicitly intended.

When telemetry is enabled, Core emits `execution-checkpoint` with
`executionCapabilities`. Observatory stores that event as a reconstructible
checkpoint artifact. It intentionally does not expose the local checkpoint
directory or state values in telemetry. Captured replay inputs remain in the
bridge's private user-data directory, not the project telemetry file.
