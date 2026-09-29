#!/usr/bin/env python3
"""Stage 1b acceptance checks (legacy paths, memory layout, plugin configs)."""

from __future__ import annotations

import re
import sys
from pathlib import Path

SERVER_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = SERVER_ROOT.parent

FORBIDDEN = (
    re.compile(r"(?<![\w./-])interfaces/"),
    re.compile(r"(?<![\w./-])frontend/"),
    re.compile(r"(?<![\w/])tools/mcp_server"),
)

SCAN_ROOTS = (
    REPO_ROOT / "server",
    REPO_ROOT / "devtools",
    REPO_ROOT / "client",
    REPO_ROOT / "run_neyra.bat",
    REPO_ROOT / "run_neyra.sh",
    REPO_ROOT / "docker-compose.yml",
    REPO_ROOT / "README.md",
    REPO_ROOT / "README-RU.md",
)

SKIP_PARTS = {
    "node_modules",
    "__pycache__",
    ".git",
    ".venv_win",
    "dist",
    "chroma_db",
}


def _scan_file(path: Path) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    hits: list[str] = []
    for i, line in enumerate(text.splitlines(), 1):
        for pat in FORBIDDEN:
            if pat.search(line):
                hits.append(f"{path.relative_to(REPO_ROOT)}:{i}: {line.strip()[:120]}")
                break
    return hits


def scan_legacy_paths() -> list[str]:
    out: list[str] = []
    for root in SCAN_ROOTS:
        if root.is_file():
            out.extend(_scan_file(root))
            continue
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if not path.is_file():
                continue
            if path.name in {"verify_stage_1b.py", "migrate_runtime_layout.py"}:
                continue
            if path.name == "config.yaml":
                continue
            if any(part in SKIP_PARTS for part in path.parts):
                continue
            if path.suffix.lower() not in {
                ".py",
                ".yaml",
                ".yml",
                ".ts",
                ".tsx",
                ".bat",
                ".sh",
                ".ps1",
                ".md",
                ".json",
            }:
                continue
            out.extend(_scan_file(path))
    return out


def check_memory_layout() -> list[str]:
    errs: list[str] = []
    mem = SERVER_ROOT / "data" / "memory"
    db = mem / "neyra_memory.db"
    if not db.is_file():
        errs.append(f"missing SQLite Hub: {db.relative_to(REPO_ROOT)}")
    chroma = mem / "chroma_db"
    if not chroma.is_dir():
        errs.append(f"missing Chroma dir: {chroma.relative_to(REPO_ROOT)}")
    for legacy in (REPO_ROOT / "memory", REPO_ROOT / "logs", REPO_ROOT / "config.yaml", REPO_ROOT / ".env"):
        if legacy.exists():
            errs.append(f"legacy root path still present: {legacy.relative_to(REPO_ROOT)}")
    return errs


def check_local_voice_merge() -> list[str]:
    cfg_path = SERVER_ROOT / "modules" / "local_voice" / "config.yaml"
    if not cfg_path.is_file():
        return ["SKIP local_voice config.yaml not present locally"]
    sys.path.insert(0, str(SERVER_ROOT))
    from core.plugins.config import merge_plugin_configs

    merged: dict = {}
    merge_plugin_configs(merged, SERVER_ROOT)
    lv = (merged.get("plugins") or {}).get("local_voice")
    if not isinstance(lv, dict) or not lv:
        return [f"local_voice config not merged into plugins.local_voice from {cfg_path}"]
    return []


def main() -> int:
    print("== Stage 1b verify ==")
    ok = True

    legacy_hits = scan_legacy_paths()
    if legacy_hits:
        ok = False
        print("FAIL legacy path scan:")
        for h in legacy_hits[:40]:
            print(" ", h)
        if len(legacy_hits) > 40:
            print(f"  ... and {len(legacy_hits) - 40} more")
    else:
        print("OK legacy path scan (no interfaces/, frontend/, tools/mcp_server)")

    mem_errs = check_memory_layout()
    if mem_errs:
        ok = False
        print("FAIL memory/layout:")
        for e in mem_errs:
            print(" ", e)
    else:
        print("OK memory under server/data/memory, no root duplicates")

    lv = check_local_voice_merge()
    if lv and lv[0].startswith("SKIP"):
        print(lv[0])
    elif lv:
        ok = False
        print("FAIL local_voice merge:")
        for e in lv:
            print(" ", e)
    else:
        print("OK local_voice config merges to plugins.local_voice")

    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
