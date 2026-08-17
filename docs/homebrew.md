# Install Koko via Homebrew

Koko is distributed through a personal Homebrew tap (not homebrew-core yet).

**Repository:** [github.com/ivanUri/koko-core](https://github.com/ivanUri/koko-core)

## Install (users)

```bash
brew tap ivanUri/tap
brew install koko
koko --help
koko serve --host 127.0.0.1 --port 9222
```

## Publish a new release (maintainers)

### Release and tap automation

The `Release` workflow builds both macOS architectures, packages the binary,
creates a GitHub Release in `koko-core`, and dispatches a `koko-release` event
to the Homebrew tap. The tap workflow downloads those release assets, computes
their SHA256 values, rewrites `Formula/koko.rb`, runs Homebrew checks, and
commits the formula update.

Release a version by updating `build.zig.zon`, then pushing a tag:

```bash
git commit -am "Release 1.0.3"
git tag v1.0.3
git push origin main --tags
```

The `koko-core` repository needs a fine-grained `HOMEBREW_TAP_TOKEN` secret
with `Contents: Read and write` access to `ivanUri/homebrew-tap`. The token is
used only for the cross-repository dispatch; no credentials are stored in the
formula or release assets.

Users upgrade with:

```bash
brew update
brew upgrade koko
```

## Tap repo layout

Create **once** on GitHub:

```
ivanUri/homebrew-tap
├── Formula/
│   └── koko.rb
└── .github/workflows/update-formula.yml
```

Homebrew resolves `brew tap ivanUri/tap` → `github.com/ivanUri/homebrew-tap`.

## What the tarball contains

| Path | Purpose |
|------|---------|
| `bin/koko` | Browser runtime binary |
| `lib/libcurl-impersonate*.dylib` | TLS impersonation (bundled) |
| `share/koko/browser/fingerprints/` | Antidetect fingerprint JSON |

The release script rewrites `@rpath` so the binary finds dylibs under `../lib` inside the Homebrew prefix.

## Notes

- **Do not** ship a source-only formula — `zig build` pulls V8 and takes too long for end users.
- License: **AGPL-3.0** — declared in the formula.
- Linux bottles need a separate tarball + formula block (`on_linux`).
