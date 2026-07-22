#!/usr/bin/env bash
set -euo pipefail
export PATH="/usr/local/go/bin:/usr/local/bin:$PATH"

echo "=== go ==="
if ! command -v go >/dev/null 2>&1; then
  cd /tmp
  curl -fsSL -o go.tgz https://go.dev/dl/go1.24.5.linux-amd64.tar.gz
  rm -rf /usr/local/go
  tar -C /usr/local -xzf go.tgz
fi
echo "go=$(go version)"

mkdir -p /root/wpt-css-work
if [ ! -d /root/wpt-css-work/demo/.git ]; then
  git clone --depth=1 https://github.com/lightpanda-io/demo.git /root/wpt-css-work/demo
fi
ls /root/wpt-css-work/demo/wptrunner
cd /root/wpt-css-work/demo/wptrunner
go run . -h 2>&1 | head -60 || true
ls
