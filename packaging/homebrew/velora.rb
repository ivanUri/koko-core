# Homebrew formula for Velora
# Tap repo: https://github.com/ivanUri/homebrew-tap
# Install: brew tap ivanUri/tap && brew install velora

class Velora < Formula
  desc "AI-first headless browser runtime for automation and agents"
  homepage "https://github.com/ivanUri/velora"
  license "AGPL-3.0-only"
  version "1.0.2"

  on_macos do
    on_arm do
      url "https://github.com/ivanUri/velora/releases/download/v1.0.2/velora-1.0.2-darwin-arm64.tar.gz"
      sha256 "a24e00dae2db1371f0a4715bd5865979f5bebaa692781c0f28ddb1faff41ded0"
    end
  end

  def install
    bin.install "bin/velora"
    lib.install Dir["lib/*.dylib"]
    (share/"velora").install "share/velora/browser"
  end

  def caveats
    <<~EOS
      Browser data:
        #{share}/velora/browser/templates
        #{share}/velora/browser/catalog

      Start CDP server:
        velora serve --host 127.0.0.1 --port 9222
    EOS
  end

  test do
    assert_match "velora", shell_output("#{bin}/velora --help", 0)
  end
end