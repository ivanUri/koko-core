# Profile bundle and template catalog (SaaS phase 1)

## Summary

Velora now supports **self-contained profile bundles** and a **versioned template catalog** as the foundation for a SaaS profile registry. Session state (cookies, localStorage) stays in the user-data-dir profile folder; fingerprint data can be loaded from a bundled snapshot or `browser/catalog/<template>@<version>/` without depending on the global `browser/templates/` layout at runtime.

## Layout

### Template catalog (immutable, versioned)

```
browser/catalog/<template-id>/<version>/
  manifest.json
  fingerprint.json    # template JSON, asset paths -> assets/*
  assets/
```

Publish:

```bash
velora profile publish --template chrome-local-huys-macbook-pro --version 1
# or: node scripts/profile-bundle.mjs publish --template ...
```

### Profile instance (tenant session)

```
~/Library/Application Support/velora/<profile-name>/
  Preferences.json    # version 2: template, template_version, snapshot
  snapshot/           # optional embedded bundle (after import)
  Cookies.json
  Local Storage/
```

`Preferences.json` v2 example:

```json
{
  "version": 2,
  "name": "my-profile",
  "template": "chrome-local-huys-macbook-pro",
  "template_version": 1,
  "snapshot": "snapshot"
}
```

### Export bundle (portable)

```
my-profile.velora-profile/
  manifest.json
  Preferences.json
  snapshot/
  session/            # Cookies.json, Local Storage/
```

## CLI

```bash
velora profile create --name <id> --template <id[@version]>
velora profile publish --template <id> [--version N]
velora profile export --name <id> [--to <dir>]
velora profile import --name <id> --from <bundle-dir>
velora serve --browser-profile <id> --profile-snapshot <bundle-dir>
```

## Resolution order (`ProfileSnapshot.zig`)

1. `--profile-snapshot` / CLI override
2. `<profile-dir>/snapshot/fingerprint.json`
3. `browser/catalog/<template>/<version>/fingerprint.json`
4. `browser/templates/<template>.json` (legacy)

Relative asset paths in bundled `fingerprint.json` resolve against the snapshot directory.

## SDK

```ts
await Browser.launch({
  profile: "my-profile",
  profileSnapshot: "/path/to/bundle/snapshot",
  dataRoot: "/path/to/velora-engine",
});
```

## Files

- `scripts/profile-bundle.mjs` — publish / export / import
- `src/runtime/profile/ProfileSnapshot.zig` — fingerprint source resolution
- `src/runtime/profile/ProfileStore.zig` — asset base for bundled paths
- `src/runtime/profile_cmd.zig` — CLI wiring

## Next (phase 2 SaaS)

- Control plane API: profile CRUD, encrypted session blobs
- Worker hydrate from remote snapshot URL
- Billing per profile instance and template tier