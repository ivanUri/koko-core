#!/usr/bin/env python3
"""Build a minimal WPT MANIFEST.json for sparse CSS testharness files."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

ROOT = Path(os.environ.get("WPT_ROOT", "/root/wpt-css-work/wpt"))
OUT = ROOT / "MANIFEST.json"

# Only include files that look like testharness tests
TH_MARKERS = (
    "testharness.js",
    "testharnessreport.js",
    "async_test(",
    "test(",
    "promise_test(",
    "setup(",
)

SKIP_PARTS = (
    "/support/",
    "/resources/",
    "/crashtests/",
    "-manual.html",
    "/reference/",
    "/reftest",
)


def is_testharness(path: Path) -> bool:
    rel = "/" + path.relative_to(ROOT).as_posix()
    if any(s in rel for s in SKIP_PARTS):
        return False
    if path.suffix not in {".html", ".htm"}:
        return False
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False
    return any(m in text for m in TH_MARKERS)


def insert(tree: dict, parts: list[str], entry):
    node = tree
    for p in parts[:-1]:
        node = node.setdefault(p, {})
    # leaf: [hash, [url_or_null, opts], ...]
    node[parts[-1]] = entry


def main() -> None:
    css_root = ROOT / "css"
    th: dict = {}
    count = 0
    for path in sorted(css_root.rglob("*.html")):
        if not is_testharness(path):
            continue
        rel = path.relative_to(ROOT).as_posix()
        parts = rel.split("/")
        # ["dummyhash", [null, {}]]
        insert(th, parts, ["0" * 40, [None, {}]])
        count += 1

    manifest = {
        "url_base": "/",
        "version": 8,
        "items": {
            "testharness": th,
        },
    }
    OUT.write_text(json.dumps(manifest), encoding="utf-8")
    print(f"wrote {OUT} with {count} testharness tests")


if __name__ == "__main__":
    main()
