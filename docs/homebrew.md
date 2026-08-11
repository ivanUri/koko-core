# Install Koko via Homebrew

Koko is distributed through a personal Homebrew tap (not homebrew-core yet).

**Repository:** [github.com/ivanUri/koko](https://github.com/ivanUri/koko)

## Install (users)

```bash
brew tap ivanUri/tap
brew install koko
koko --help
koko serve --host 127.0.0.1 --port 9222
```

## Publish a new release (maintainers)

### 1. Build release tarball(s)

On each macOS architecture you support:

```bash
zig build -Doptimize=ReleaseFast
./scripts/release-macos.sh 1.0.0
```

Output: `dist/koko-1.0.0-darwin-arm64.tar.gz` (+ SHA256 printed).

Repeat on an Intel Mac for `darwin-x86_64` if you ship both arches.

### 2. Create GitHub Release

```bash
gh release create v1.0.0 \
  dist/koko-1.0.0-darwin-arm64.tar.gz \
  dist/koko-1.0.0-darwin-x86_64.tar.gz
```

Or upload tarballs manually at [Releases](https://github.com/ivanUri/koko/releases).

### 3. Update the formula

Copy `packaging/homebrew/koko.rb` into the tap repo
[github.com/ivanUri/homebrew-tap](https://github.com/ivanUri/homebrew-tap) as `Formula/koko.rb`.

Set:

- `version`
- `url` (must match release asset URLs)
- `sha256` for each arch (`shasum -a 256 dist/*.tar.gz`)

```bash
cd ~/homebrew-tap
cp /path/to/koko/packaging/homebrew/koko.rb Formula/koko.rb
# edit sha256 values
git add Formula/koko.rb
git commit -m "koko 1.0.0"
git push
```

Users upgrade with:

```bash
brew update
brew upgrade koko
```

## Tap repo layout

Create **once** on GitHub:

```
ivanUri/homebrew-tap
└── Formula/
    └── koko.rb
```

Homebrew resolves `brew tap ivanUri/tap` → `github.com/ivanUri/homebrew-tap`.

## What the tarball contains

| Path | Purpose |
|------|---------|
| `bin/koko` | Browser runtime binary |
| `lib/libcurl-impersonate*.dylib` | TLS impersonation (bundled) |
| `share/koko/browser/profiles/` | Antidetect profile JSON |

The release script rewrites `@rpath` so the binary finds dylibs under `../lib` inside the Homebrew prefix.

## Notes

- **Do not** ship a source-only formula — `zig build` pulls V8 and takes too long for end users.
- License: **AGPL-3.0** — declared in the formula.
- Linux bottles need a separate tarball + formula block (`on_linux`).