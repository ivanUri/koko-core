# Self-contained fingerprint folders

## Invariant

A fingerprint is exactly one self-contained folder:

```text
browser/fingerprints/<fingerprint-id>/
  fingerprint.json
  assets/                 # optional; every reference is relative to the folder
```

There is no template/catalog distinction, version directory, external asset
root, or manifest sidecar. The folder is the unit of capture, validation,
copy, import, export, and runtime loading.

Profiles store only the fingerprint id:

```json
{
  "version": 3,
  "name": "my-profile",
  "fingerprint": "chrome-macos-sonoma"
}
```

A portable profile may embed the same folder shape at
`<profile-dir>/fingerprint/`. Session state remains separate.

## Resolution

Runtime selects one folder, with no legacy-format fallback:

1. Explicit `--fingerprint-folder <dir>`
2. `<profile-dir>/fingerprint/`
3. `browser/fingerprints/<Preferences.fingerprint>/`

The selected folder owns its asset root for the entire parse. Missing
fingerprints fail startup instead of silently selecting another source.

## Profile bundle

```text
my-profile.koko-profile/
  Preferences.json
  fingerprint/
    fingerprint.json
    assets/
  session/
    Cookies.json
    Local Storage/
```

`koko profile export` and `import` copy the fingerprint folder atomically.
`scripts/capture-fingerprint.js` also writes to a staging folder and atomically
publishes the completed fingerprint.

Only `Preferences.json` v3 is accepted. Runtime has no legacy storage or schema
fallback.
