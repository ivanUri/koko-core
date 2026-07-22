#!/usr/bin/env python3
import re
import pathlib

build = pathlib.Path("/root/velora/build.zig").read_text()
idx = build.find("BUILDING_LIBCURL")
sub = build[idx : idx + 12000]
m = re.search(r"\.files = &\.\{(.*?)\},", sub, re.S)
if not m:
    raise SystemExit("files block not found")
files = re.findall(r'"([^"]+\.c)"', m.group(1))
lib = pathlib.Path("/root/.cache/zig/p/N-V-__8AAHGgPwH1XE5mB7bNofrDyBE5VWADWmBRlFQaVXWU/lib")
missing = [f for f in files if not (lib / f).exists()]
print("total listed", len(files))
print("missing", len(missing))
for f in missing:
    print(" ", f)
