#!/usr/bin/env python3
"""Wrap inline scripts so they wait for testharness globals (Velora classic-script ordering quirk)."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path("/root/wpt-css-work/wpt")
# Only touch CSS suites we care about
SUITES = [
    "css/css-syntax",
    "css/cssom",
    "css/css-variables",
    "css/css-cascade",
]

WRAPPER_PREFIX = """(function(){function __veloraWait(fn){if(typeof test==='function'&&typeof assert_true==='function'){fn();}else{setTimeout(function(){__veloraWait(fn);},20);}}__veloraWait(function(){\n"""
WRAPPER_SUFFIX = "\n});})();"

SKIP_RE = re.compile(
    r"testharness|testharnessreport|idlharness|WebIDLParser|/resources/",
    re.I,
)


def wrap_inline_scripts(html: str) -> str:
    if "__veloraWait" in html:
        return html  # already processed

    out = []
    i = 0
    lower = html
    while True:
        start = lower.find("<script", i)
        if start == -1:
            out.append(html[i:])
            break
        out.append(html[i:start])
        end_open = lower.find(">", start)
        if end_open == -1:
            out.append(html[start:])
            break
        open_tag = html[start : end_open + 1]
        # self-closing or external
        if re.search(r"\bsrc\s*=", open_tag, re.I) or open_tag.rstrip().endswith("/>"):
            close = lower.find("</script>", end_open + 1)
            if close == -1:
                out.append(html[start:])
                break
            out.append(html[start : close + len("</script>")])
            i = close + len("</script>")
            continue
        close = lower.find("</script>", end_open + 1)
        if close == -1:
            out.append(html[start:])
            break
        body = html[end_open + 1 : close]
        # Don't wrap empty or already harness setup only
        if body.strip() and not SKIP_RE.search(body[:200]):
            body = WRAPPER_PREFIX + body + WRAPPER_SUFFIX
        out.append(open_tag + body + "</script>")
        i = close + len("</script>")
    return "".join(out)


def main() -> None:
    n = 0
    for suite in SUITES:
        base = ROOT / suite
        if not base.is_dir():
            continue
        for path in base.rglob("*.html"):
            text = path.read_text(encoding="utf-8", errors="ignore")
            if "testharness.js" not in text:
                continue
            new = wrap_inline_scripts(text)
            if new != text:
                # backup once
                bak = path.with_suffix(path.suffix + ".bak")
                if not bak.exists():
                    bak.write_text(text, encoding="utf-8")
                path.write_text(new, encoding="utf-8")
                n += 1
    print(f"preprocessed {n} html files")


if __name__ == "__main__":
    main()
