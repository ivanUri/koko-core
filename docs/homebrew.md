# Install Velora via Homebrew

Velora is distributed through a personal Homebrew tap (not homebrew-core yet).

**Repository:** [github.com/ivanUri/velora](https://github.com/ivanUri/velora)

## Install (users)

```bash
brew tap ivanUri/tap
brew install velora
velora --help
velora serve --host 127.0.0.1 --port 9222
```

## Publish a new release (maintainers)

### 1. Build release tarball(s)

On each macOS architecture you support:

```bash
zig build -Doptimize=ReleaseFast
./scripts/release-macos.sh 1.0.0
```

Output: `dist/velora-1.0.0-darwin-arm64.tar.gz` (+ SHA256 printed).

Repeat on an Intel Mac for `darwin-x86_64` if you ship both arches.

### 2. Create GitHub Release

```bash
gh release create v1.0.0 \
  dist/velora-1.0.0-darwin-arm64.tar.gz \
  dist/velora-1.0.0-darwin-x86_64.tar.gz
```

Or upload tarballs manually at [Releases](https://github.com/ivanUri/velora/releases).

### 3. Update the formula

Copy `packaging/homebrew/velora.rb` into the tap repo
[github.com/ivanUri/homebrew-tap](https://github.com/ivanUri/homebrew-tap) as `Formula/velora.rb`.

Set:

- `version`
- `url` (must match release asset URLs)
- `sha256` for each arch (`shasum -a 256 dist/*.tar.gz`)

```bash
cd ~/homebrew-tap
cp /path/to/velora/packaging/homebrew/velora.rb Formula/velora.rb
# edit sha256 values
git add Formula/velora.rb
git commit -m "velora 1.0.0"
git push
```

Users upgrade with:

```bash
brew update
brew upgrade velora
```

## Tap repo layout

Create **once** on GitHub:

```
ivanUri/homebrew-tap
└── Formula/
    └── velora.rb
```

Homebrew resolves `brew tap ivanUri/tap` → `github.com/ivanUri/homebrew-tap`.

## What the tarball contains

| Path | Purpose |
|------|---------|
| `bin/velora` | Browser runtime binary |
| `lib/libcurl-impersonate*.dylib` | TLS impersonation (bundled) |
| `share/velora/browser/profiles/` | Antidetect profile JSON |

The release script rewrites `@rpath` so the binary finds dylibs under `../lib` inside the Homebrew prefix.

## Notes

- **Do not** ship a source-only formula — `zig build` pulls V8 and takes too long for end users.
- License: **AGPL-3.0** — declared in the formula.
- Linux bottles need a separate tarball + formula block (`on_linux`).