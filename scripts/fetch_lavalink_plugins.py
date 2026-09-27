#!/usr/bin/env python3
"""
Скачать JAR-плагины Lavalink v4 (youtube-source, LavaSrc и т.д.).

В репозитории под interfaces/discord/lavalink/plugins/*.jar часто лежат Git LFS pointer-файлы
(~130 байт) — Lavalink падает с java.util.zip.ZipException: zip END header not found.

Пример:
  python scripts/fetch_lavalink_plugins.py
  python scripts/fetch_lavalink_plugins.py --config interfaces/discord/lavalink/application.yml
"""

from __future__ import annotations

import argparse
import json
import re
import ssl
import sys
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CFG = ROOT / "interfaces" / "discord" / "lavalink" / "application.yml"
FALLBACK_CFG = ROOT / "interfaces" / "discord" / "lavalink" / "application.example.yml"

# Maven-строка из YAML -> URL релиза GitHub (плагины Lavalink часто не на Maven Central).
PLUGIN_DOWNLOAD_URLS: dict[tuple[str, str], str] = {
    ("dev.lavalink.youtube", "youtube-plugin"): (
        "https://github.com/lavalink-devs/youtube-source/releases/download/{ver}/youtube-plugin-{ver}.jar"
    ),
    ("com.github.topi314.lavasrc", "lavasrc-plugin"): (
        "https://github.com/topi314/LavaSrc/releases/download/{ver}/lavasrc-plugin-{ver}.jar"
    ),
}

GITHUB_LATEST_TAG_API = {
    ("dev.lavalink.youtube", "youtube-plugin"): "https://api.github.com/repos/lavalink-devs/youtube-source/releases/latest",
}


def _http_get_json(url: str, timeout: float = 30.0) -> dict | None:
    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        url,
        headers={"Accept": "application/vnd.github+json", "User-Agent": "neyra-fetch-lavalink-plugins"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, json.JSONDecodeError, OSError):
        return None


def _latest_github_tag(owner_repo_key: tuple[str, str]) -> str | None:
    url = GITHUB_LATEST_TAG_API.get(owner_repo_key)
    if not url:
        return None
    data = _http_get_json(url)
    if not data:
        return None
    tag = str(data.get("tag_name") or "").strip().lstrip("v")
    return tag or None


def _http_download(url: str, dest: Path, timeout: float = 120.0) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    ctx = ssl.create_default_context()
    req = urllib.request.Request(url, headers={"User-Agent": "neyra-fetch-lavalink-plugins"})
    print(f"Downloading {url} ...")
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        data = resp.read()
    tmp = dest.with_suffix(dest.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(dest)
    print(f"Wrote {dest} ({len(data)} bytes)")


def _is_git_lfs_pointer(path: Path) -> bool:
    try:
        head = path.read_text(encoding="utf-8", errors="ignore")[:80]
    except OSError:
        return False
    return head.startswith("version https://git-lfs.github.com/spec/v1")


def _prune_other_youtube_plugin_jars(plugins_dir: Path, keep: Path) -> None:
    """Оставляем один youtube-plugin-*.jar, чтобы Lavalink не подхватил несколько версий."""
    try:
        for p in plugins_dir.glob("youtube-plugin-*.jar"):
            if p.resolve() != keep.resolve() and p.is_file():
                p.unlink()
                print(f"Removed old plugin jar: {p.name}")
    except OSError as e:
        print(f"[WARN] Не удалось удалить старый youtube-plugin jar: {e}", file=sys.stderr)


def _is_valid_plugin_jar(path: Path) -> bool:
    if not path.is_file():
        return False
    if path.stat().st_size < 4096:
        return False
    if _is_git_lfs_pointer(path):
        return False
    try:
        with zipfile.ZipFile(path) as zf:
            if zf.testzip() is not None:
                return False
    except zipfile.BadZipFile:
        return False
    return True


def _sync_youtube_plugin_version_in_yaml(cfg: Path, new_ver: str) -> None:
    """Подставить версию youtube-plugin в dependency внутри YAML (одна строка)."""
    text = cfg.read_text(encoding="utf-8")
    new_text, n = re.subn(
        r'(dependency:\s*"dev\.lavalink\.youtube:youtube-plugin:)([^"]+)(")',
        rf"\g<1>{new_ver}\3",
        text,
        count=1,
    )
    if n and new_text != text:
        cfg.write_text(new_text, encoding="utf-8")
        print(f"[OK] Updated application.yml dependency youtube-plugin -> {new_ver}")


def _parse_plugin_dependencies(cfg: Path) -> list[tuple[str, str, str]]:
    if not cfg.is_file():
        return []
    text = cfg.read_text(encoding="utf-8")
    out: list[tuple[str, str, str]] = []
    for m in re.finditer(r'dependency:\s*"([^":]+):([^":]+):([^"]+)"', text):
        gid, aid, ver = m.group(1).strip(), m.group(2).strip(), m.group(3).strip()
        out.append((gid, aid, ver))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--config",
        type=Path,
        default=DEFAULT_CFG if DEFAULT_CFG.is_file() else FALLBACK_CFG,
        help="application.yml (или example) с блоком lavalink.plugins",
    )
    ap.add_argument(
        "--plugins-dir",
        type=Path,
        default=None,
        help="Каталог plugins (по умолчанию рядом с application.yml)",
    )
    ap.add_argument(
        "--force",
        action="store_true",
        help="Перекачать даже если JAR уже валидный ZIP",
    )
    ap.add_argument(
        "--latest-youtube",
        action="store_true",
        help="Подставить последний tag youtube-plugin с GitHub (lavalink-devs/youtube-source) вместо версии из YAML",
    )
    args = ap.parse_args()

    cfg: Path = args.config.resolve()
    if not cfg.is_file():
        print(f"[ERR] Нет конфига: {cfg}", file=sys.stderr)
        return 1

    plugins_dir = args.plugins_dir
    if plugins_dir is None:
        plugins_dir = cfg.parent / "plugins"
    else:
        plugins_dir = plugins_dir.resolve()
    plugins_dir.mkdir(parents=True, exist_ok=True)

    deps = _parse_plugin_dependencies(cfg)
    if not deps:
        print(f"[WARN] В {cfg} не найдены строки dependency: \"...\" — нечего качать.")
        return 0

    if args.latest_youtube:
        yt_ver = _latest_github_tag(("dev.lavalink.youtube", "youtube-plugin"))
        if yt_ver:
            print(f"[INFO] GitHub latest youtube-plugin: {yt_ver}")
            # Do NOT rewrite YAML until the jar download succeeds (see loop below).
            deps = [
                (gid, aid, yt_ver if (gid, aid) == ("dev.lavalink.youtube", "youtube-plugin") else ver)
                for gid, aid, ver in deps
            ]
        else:
            print(
                "[WARN] Не удалось получить latest tag для youtube-plugin — использую версии из YAML.",
                file=sys.stderr,
            )

    need_any = False
    failed = False
    for gid, aid, ver in deps:
        key = (gid, aid)
        tmpl = PLUGIN_DOWNLOAD_URLS.get(key)
        if not tmpl:
            print(f"[WARN] Нет URL для {gid}:{aid}:{ver} — добавь в PLUGIN_DOWNLOAD_URLS в fetch_lavalink_plugins.py")
            continue
        url = tmpl.format(ver=ver)
        dest = plugins_dir / f"{aid}-{ver}.jar"
        if args.force or not _is_valid_plugin_jar(dest):
            need_any = True
            try:
                _http_download(url, dest)
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError) as e:
                print(f"[ERR] Не удалось скачать {url}: {e}", file=sys.stderr)
                # Keep an already-valid older youtube-plugin jar if present.
                if key == ("dev.lavalink.youtube", "youtube-plugin"):
                    existing = sorted(plugins_dir.glob("youtube-plugin-*.jar"), reverse=True)
                    keep = next((p for p in existing if _is_valid_plugin_jar(p)), None)
                    if keep is not None:
                        m = re.search(r"youtube-plugin-([0-9.]+)\.jar$", keep.name)
                        if m:
                            _sync_youtube_plugin_version_in_yaml(cfg, m.group(1))
                        print(f"[WARN] Оставляю существующий плагин: {keep.name}")
                        continue
                failed = True
                continue
            if not _is_valid_plugin_jar(dest):
                print(f"[ERR] После загрузки файл не похож на JAR: {dest}", file=sys.stderr)
                failed = True
                continue
            if key == ("dev.lavalink.youtube", "youtube-plugin"):
                _sync_youtube_plugin_version_in_yaml(cfg, ver)
                _prune_other_youtube_plugin_jars(plugins_dir, dest)
        else:
            print(f"[OK] Плагин уже на месте: {dest.name}")
            if key == ("dev.lavalink.youtube", "youtube-plugin") and args.latest_youtube:
                _sync_youtube_plugin_version_in_yaml(cfg, ver)

    if not need_any:
        print("Все известные плагины уже валидные JAR.")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
