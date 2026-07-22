#!/usr/bin/env bash
set -euo pipefail
TH=/root/wpt-css-work/wpt/resources/testharness.js
echo "size=$(wc -c < "$TH")"
tail -40 "$TH"
echo "==== matches ===="
grep -n "global_scope\|window\.test\|self\.test\|function test\|exports_object\|expose_tests" "$TH" | head -50
echo "==== node syntax check ===="
node --check "$TH" 2>&1 | head -20 || true
echo "==== first 100 lines after 'use strict' or IIFE start ===="
head -80 "$TH"
