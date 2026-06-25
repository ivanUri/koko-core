#!/bin/bash
PORT="${1:-57200}"
for i in $(seq 1 80); do
  if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; then
    echo "ready at $i"
    exit 0
  fi
  sleep 0.25
done
echo "not ready"
exit 1