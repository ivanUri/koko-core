# Chrome-like profile storage layout

## Summary

Koko profile state (cookies and localStorage) lives in `Storage.sqlite` under a Chrome-style **user-data-dir** with sibling profile folders. SQLite WAL is the durable source of truth; Web APIs continue to use session RAM as hot state. `sessionStorage` remains ephemeral. Fingerprints are self-contained folders under `browser/fingerprints/`.

## Layout

```
~/Library/Application Support/koko/   # --user-data-dir (macOS default)
  Default/
    Preferences.json    # { "version": 3, "fingerprint": "koko" }
    Storage.sqlite      # cookies + localStorage; WAL mode, schema v4
    Storage.sqlite.writer.lock
    Cookies.json        # retained legacy import/export source
    Local Storage/storage.json  # retained legacy import source
    Cache/
  chrome-local-huys-macbook-pro/
    Preferences.json    # { "version": 3, "fingerprint": "chrome-local-huys-macbook-pro" }
    ...
```

Repo (read-only):

```
browser/fingerprints/<id>/
  fingerprint.json
  assets/
browser/koko.json           # default template
```

## Code

| Module | Role |
|--------|------|
| `src/runtime/profile/ProfilePaths.zig` | user-data-dir, profile dir paths, first-run bootstrap |
| `src/runtime/Config.zig` | `--user-data-dir`, derive cookie/cache paths |
| `src/runtime/profile/ProfileStore.zig` | load a resolved fingerprint folder |
| `src/runtime/profile/FingerprintStore.zig` | resolve explicit, embedded, or installed fingerprint folder |
| `src/runtime/storage/Storage.zig` | Select storage engine and expose profile-state operations |
| `src/runtime/storage/sqlite/Store.zig` | Bounded queue, single writer, batching, coalescing, flush barriers |
| `src/runtime/storage/sqlite/migrations.zig` | Transactional browser-state schema migrations |
| `src/runtime/profile_session.zig` | SQLite bootstrap plus one-time JSON import/fallback |
| `scripts/migrate-profile-layout.mjs` | migrate legacy `browser/*/sessions/` jars |

## CLI

- `--user-data-dir` — override profile root (like Chrome)
- `--browser-profile NAME` — profile **folder** name (default: `Default`)
- `--cookie-jar` — deprecated override for `Cookies.json` path
- `--storage-engine sqlite|none` — SQLite is the default; `none` retains JSON compatibility mode
- `--storage-sqlite-path PATH` — optional explicit database path; default is `<profile>/Storage.sqlite`

## Persistence lifecycle

1. `Session` creates RAM `Cookie.Jar` and origin `storage.Shed`.
2. Profile bootstrap flushes older accepted commands, then restores cookies and localStorage from SQLite.
3. First open imports validated JSON without deleting it and commits a profile marker.
4. Runtime mutations update RAM synchronously and enqueue owned commands.
5. The bounded writer coalesces commands and commits batches in SQLite WAL with `synchronous=FULL`.
6. Session/browser shutdown waits on a flush barrier before releasing session arenas.

Only one process may own a database writer lock. `sessionStorage` is not enqueued unless a future resumable-session feature explicitly adopts the v4 session tables.

## Migration

```bash
node scripts/migrate-profile-layout.mjs
```

Moves `*-cookies.json` and sidecar `.storage.json` into user-data-dir profile folders.

## Multi-user / product (phase 2)

### Local State.json

Chrome-style registry at user-data-dir root:

```json
{
  "version": 1,
  "profiles": ["Default", "chrome-local-huys-macbook-pro"],
  "last_used": "chrome-local-huys-macbook-pro"
}
```

- `profiles` is synced from **on-disk profile directories** (not stale JSON entries).
- `last_used` is updated on `profile create` / `profile delete` (informational in `profile list` only).

### Profile CLI

```bash
koko profile list
koko profile create --name <id> [--template <template-id>]
koko profile delete --name <id>
koko profile import-cookies [--name <id>] --from <cookies.json>
```

### Install root resolution (`BrowserRoot.zig`)

Template JSON is resolved without CWD:

1. `KOKO_ROOT` env
2. Exe-relative `../../` (dev) or `../share/koko` (Homebrew)
3. Current directory fallback

### Active profile resolution

Priority: `--browser-profile` → `--browser-profile-pool` pick → `Default` (no implicit sticky profile).

`ensureFirstRun` creates `Default/` with template `koko` when user-data-dir is empty.

## Removed

- `session.cookieSeedFile` / `session.cookieRuntimeFile` in template JSON
- `{jar}.storage.json` sidecar next to cookie jar
