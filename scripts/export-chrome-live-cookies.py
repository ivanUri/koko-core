#!/usr/bin/env python3
"""
Export live Chrome cookies (macOS Keychain decrypt) into Velora Cookies.json format.

Requires: browser-cookie3 (see velora-run/.venv-cookies).

  # default: Google-related cookies → profile + seed
  ./scripts/export-chrome-live-cookies.py

  # all domains
  ./scripts/export-chrome-live-cookies.py --all

  # only print stats
  ./scripts/export-chrome-live-cookies.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DEFAULT_PROFILE = "chrome-local-huys-macbook-pro"
CHROME_COOKIES = (
    Path.home()
    / "Library/Application Support/Google/Chrome/Default/Cookies"
)

GOOGLE_DOMAIN_NEEDLES = (
    "google.",
    "youtube.",
    "gstatic.",
    "ggpht.",
    "doubleclick.",
    "googleusercontent.",
    "googleapis.",
    "gvt1.",
    "gvt2.",
)


def find_python_with_bc() -> None:
    try:
        import browser_cookie3  # noqa: F401
    except ImportError:
        venv_py = REPO.parent / "velora-run" / ".venv-cookies" / "bin" / "python"
        if venv_py.exists():
            print(
                f"browser_cookie3 not in this interpreter.\n"
                f"Run with: {venv_py} {Path(__file__).name} ...\n"
                f"Or: cd ../velora-run && python3 -m venv .venv-cookies && "
                f".venv-cookies/bin/pip install browser-cookie3",
                file=sys.stderr,
            )
        else:
            print(
                "Install browser-cookie3 first:\n"
                "  python3 -m venv .venv && .venv/bin/pip install browser-cookie3",
                file=sys.stderr,
            )
        sys.exit(2)


def to_velora(c) -> dict:
    exp = getattr(c, "expires", None)
    expires = float(exp) if exp and exp > 0 else None
    # browser_cookie3 does not always expose HttpOnly; default false is OK for hop-1 Cookie header.
    http_only = False
    rest = getattr(c, "rest", None) or {}
    if isinstance(rest, dict) and rest.get("HttpOnly"):
        http_only = True
    return {
        "name": c.name,
        "value": c.value or "",
        "domain": c.domain or "",
        "path": c.path or "/",
        "expires": expires,
        "secure": bool(getattr(c, "secure", False)),
        "httpOnly": http_only,
        "sameSite": "Lax",
    }


def is_google_related(domain: str) -> bool:
    d = (domain or "").lower()
    return any(n in d for n in GOOGLE_DOMAIN_NEEDLES)


def profile_cookies_path(profile: str) -> Path:
    return (
        Path.home()
        / "Library/Application Support/velora"
        / profile
        / "Cookies.json"
    )


def seed_cookies_path(profile: str) -> Path:
    return REPO / "browser/templates/sessions" / f"{profile}-cookies.json"


def assets_seed_path(profile: str) -> Path:
    return (
        REPO
        / "browser/templates/assets"
        / f"{profile}-session-cookies.json"
    )


def main() -> int:
    find_python_with_bc()
    import browser_cookie3 as bc

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--profile", default=DEFAULT_PROFILE)
    ap.add_argument(
        "--all",
        action="store_true",
        help="Export all Chrome cookies (default: Google-related only)",
    )
    ap.add_argument(
        "--cookie-file",
        default=None,
        help="Path to Chrome Cookies SQLite (default: copy of Default profile)",
    )
    ap.add_argument("--out", default=None, help="Write only to this path")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    # Copy while Chrome is running — live DB is often locked for write but
    # a file copy still works for read.
    tmp = Path(tempfile.mkdtemp(prefix="velora-chrome-cookies-"))
    cookie_src = Path(args.cookie_file) if args.cookie_file else CHROME_COOKIES
    if not cookie_src.exists():
        print(f"Chrome cookie DB not found: {cookie_src}", file=sys.stderr)
        return 1
    cookie_copy = tmp / "Cookies"
    shutil.copy2(cookie_src, cookie_copy)

    print(f"source: {cookie_src}")
    print(f"copy:   {cookie_copy}")

    jar = bc.chrome(cookie_file=str(cookie_copy))
    all_cookies = list(jar)
    if args.all:
        selected = all_cookies
        label = "all domains"
    else:
        selected = [c for c in all_cookies if is_google_related(c.domain or "")]
        label = "google-related"

    out = [to_velora(c) for c in selected]
    nid = [c for c in selected if c.name == "NID"]
    sid = [c for c in selected if c.name in ("SID", "SAPISID", "__Secure-1PSID", "__Secure-3PSID")]

    print(f"exported {len(out)} cookies ({label}) from {len(all_cookies)} total")
    print(f"  NID: {[(len(c.value or ''), c.domain) for c in nid]}")
    print(f"  session-ish: {[(c.name, len(c.value or '')) for c in sid[:12]]}")

    if args.dry_run:
        return 0

    targets: list[Path] = []
    if args.out:
        targets = [Path(args.out)]
    else:
        targets = [
            profile_cookies_path(args.profile),
            seed_cookies_path(args.profile),
            assets_seed_path(args.profile),
        ]

    payload = json.dumps(out, indent=2) + "\n"
    for t in targets:
        t.parent.mkdir(parents=True, exist_ok=True)
        if t.exists():
            bak = t.with_suffix(t.suffix + f".bak")
            shutil.copy2(t, bak)
        t.write_text(payload)
        print(f"wrote {t} ({len(out)} cookies)")

    shutil.rmtree(tmp, ignore_errors=True)
    print("done — restart velora with profile to load Cookies.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
