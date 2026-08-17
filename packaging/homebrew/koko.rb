# Homebrew formula for Koko
# Tap repo: https://github.com/ivanUri/homebrew-tap
# Install: brew tap ivanUri/tap && brew install koko

class Koko < Formula
  desc "AI-first headless browser runtime for automation and agents"
  homepage "https://github.com/ivanUri/koko-core"
  version "1.0.2"
  license "AGPL-3.0-only"

  on_macos do
    on_arm do
      url "https://github.com/ivanUri/koko-core/releases/download/v1.0.2/koko-1.0.2-darwin-arm64.tar.gz"
      sha256 "541ada419b4eef6621ba9402feb433df40927f9ec27daf5d4b61b685daf27220"
    end
  end

  def install
    bin.install "bin/koko"
    lib.install Dir["lib/*.dylib"]
    (share/"koko").install "share/koko/browser"
  end

  def caveats
    <<~EOS
      Browser data:
        #{share}/koko/browser/templates
        #{share}/koko/browser/catalog

      Start CDP server:
        koko serve --host 127.0.0.1 --port 9222
    EOS
  end

  test do
    assert_match "koko", shell_output("#{bin}/koko --help", 0)
  end
end
