# Homebrew formula for Velora
# Tap repo: https://github.com/ivanUri/homebrew-tap
# Install: brew tap ivanUri/tap && brew install velora
#
# After each release, update VERSION, url, and sha256 (per arch).

class Velora < Formula
  desc "AI-first headless browser runtime for automation and agents"
  homepage "https://github.com/ivanUri/velora"
  license "AGPL-3.0-only"
  version "1.0.0"

  on_macos do
    on_arm do
      url "https://github.com/ivanUri/velora/releases/download/v1.0.0/velora-1.0.0-darwin-arm64.tar.gz"
      sha256 "REPLACE_WITH_ARM64_SHA256"
    end
    on_intel do
      url "https://github.com/ivanUri/velora/releases/download/v1.0.0/velora-1.0.0-darwin-x86_64.tar.gz"
      sha256 "REPLACE_WITH_X86_64_SHA256"
    end
  end

  def install
    bin.install "bin/velora"
    lib.install Dir["lib/*.dylib"]
    (share/"velora").install "share/velora/browser"
  end

  def caveats
    <<~EOS
      Browser profiles:
        #{share}/velora/browser/profiles

      Start CDP server:
        velora serve --host 127.0.0.1 --port 9222

      Run from a git checkout if you need repo-relative profile paths:
        cd $(brew --prefix)/share/velora && velora serve ...
    EOS
  end

  test do
    assert_match "velora", shell_output("#{bin}/velora --help", 0)
  end
end