# Chrome-like profile storage layout

## Summary

Velora session state (cookies, localStorage, HTTP cache) lives under a Chrome-style **user-data-dir** with sibling profile folders. Fingerprints are self-contained folders under `browser/fingerprints/`.

## Layout

```
~/Library/Application Support/velora/   # --user-data-dir (macOS default)
  Default/
    Preferences.json    # { "version": 3, "fingerprint": "velora" }
    Cookies.json
    Local Storage/storage.json
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
browser/velora.json           # default template
```

## Code

| Module | Role |
|--------|------|
| `src/runtime/profile/ProfilePaths.zig` | user-data-dir, profile dir paths, first-run bootstrap |
| `src/runtime/Config.zig` | `--user-data-dir`, derive cookie/cache paths |
| `src/runtime/profile/ProfileStore.zig` | load a resolved fingerprint folder |
| `src/runtime/profile/FingerprintStore.zig` | resolve explicit, embedded, or installed fingerprint folder |
| `src/runtime/profile_session.zig` | load/save `Cookies.json` + `Local Storage/` |
| `scripts/migrate-profile-layout.mjs` | migrate legacy `browser/*/sessions/` jars |

## CLI

- `--user-data-dir` — override profile root (like Chrome)
- `--browser-profile NAME` — profile **folder** name (default: `Default`)
- `--cookie-jar` — deprecated override for `Cookies.json` path

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
velora profile list
velora profile create --name <id> [--template <template-id>]
velora profile delete --name <id>
velora profile import-cookies [--name <id>] --from <cookies.json>
```

### Install root resolution (`BrowserRoot.zig`)

Template JSON is resolved without CWD:

1. `VELORA_ROOT` env
2. Exe-relative `../../` (dev) or `../share/velora` (Homebrew)
3. Current directory fallback

### Active profile resolution

Priority: `--browser-profile` → `--browser-profile-pool` pick → `Default` (no implicit sticky profile).

`ensureFirstRun` creates `Default/` with template `velora` when user-data-dir is empty.

## Removed

- `session.cookieSeedFile` / `session.cookieRuntimeFile` in template JSON
- `{jar}.storage.json` sidecar next to cookie jar
