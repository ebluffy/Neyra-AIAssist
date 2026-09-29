#!/usr/bin/env python3
"""
Скачать Lavalink.jar с GitHub (обход Git LFS pointer в репозитории).

Пример:
  python scripts/fetch_lavalink.py
  python scripts/fetch_lavalink.py --version 4.1.1
"""

from __future__ import annotations

import argparse
import json
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path


REPO_API = "https://api.github.com/repos/lavalink-devs/Lavalink/releases/latest"
DEFAULT_FALLBACK_TAG = "4.1.1"


def _http_get_json(url: str, timeout: float = 30.0) -> dict:
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "neyra-fetch-lavalink"})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        return json.loads(resp.read().decode("utf-8"))


def resolve_tag(explicit: str | None) -> str:
    if explicit:
        return explicit.strip().lstrip("v")
    try:
        data = _http_get_json(REPO_API)
        tag = str(data.get("tag_name") or "").strip().lstrip("v")
        if tag:
            return tag
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, OSError):
        pass
    return DEFAULT_FALLBACK_TAG


def download_jar(tag: str, dest: Path) -> None:
    url = f"https://github.com/lavalink-devs/Lavalink/releases/download/{tag}/Lavalink.jar"
    dest.parent.mkdir(parents=True, exist_ok=True)
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": "neyra-fetch-lavalink"})
    print(f"Downloading {url} ...")
    with urllib.request.urlopen(req, timeout=120, context=ctx) as resp:
        data = resp.read()
    if len(data) < 1_048_576:
        raise SystemExit(f"Downloaded file too small ({len(data)} bytes); wrong URL or blocked?")
    dest.write_bytes(data)
    print(f"Wrote {dest} ({len(data)} bytes)")


def main() -> int:
    ap = argparse.ArgumentParser(description="Download Lavalink.jar into modules/discord/lavalink/")
    ap.add_argument("--version", help="Release tag, e.g. 4.1.1 (default: GitHub latest, fallback 4.1.1)")
    ap.add_argument(
        "--dest",
        type=Path,
        default=None,
        help="Output path (default: <repo>/modules/discord/lavalink/Lavalink.jar)",
    )
    args = ap.parse_args()
    root = Path(__file__).resolve().parent.parent
    dest = args.dest or (root / "modules" / "discord" / "lavalink" / "Lavalink.jar")
    tag = resolve_tag(args.version)
    print(f"Using Lavalink version tag: {tag}")
    try:
        download_jar(tag, dest)
    except urllib.error.HTTPError as e:
        print(f"HTTP error: {e}", file=sys.stderr)
        if e.code == 404 and not args.version:
            print(f"Retrying fallback tag {DEFAULT_FALLBACK_TAG} ...", file=sys.stderr)
            download_jar(DEFAULT_FALLBACK_TAG, dest)
        else:
            return 1
    except Exception as e:
        print(str(e), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
