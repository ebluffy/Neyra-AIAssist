"""Resolve server data directory (paths.data_dir, NEYRA_DATA_DIR)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

# Relative memory.* keys rewritten under memory_dir when not absolute.
_MEMORY_PATH_KEYS = (
    "sqlite_path",
    "chroma_db_path",
    "journal_path",
    "diary_path",
    "thoughts_log",
)

_MEMORY_NESTED_PATH_KEYS = {
    "ltm_consolidation": ("log_dir",),
    "working_memory": ("storage_dir", "shared_file_path"),
}


def resolve_data_dir(server_root: Path, config: dict[str, Any] | None = None) -> Path:
    """Canonical runtime data root (contains memory/, not logs/)."""
    env = (os.environ.get("NEYRA_DATA_DIR") or "").strip()
    if env:
        p = Path(env).expanduser()
        return p.resolve() if p.is_absolute() else (server_root / p).resolve()

    cfg = config if isinstance(config, dict) else {}
    paths = cfg.get("paths") if isinstance(cfg.get("paths"), dict) else {}
    raw = str((paths or {}).get("data_dir") or "./data").strip() or "./data"
    p = Path(raw)
    if p.is_absolute():
        return p.resolve()
    return (server_root / p).resolve()


def memory_dir(server_root: Path, config: dict[str, Any] | None = None) -> Path:
    return resolve_data_dir(server_root, config) / "memory"


def resolve_memory_path(
    server_root: Path,
    config: dict[str, Any] | None,
    configured: str | None,
    default_rel: str,
) -> Path:
    """Map relative memory paths onto memory_dir (honours NEYRA_DATA_DIR / paths.data_dir)."""
    raw = (configured or default_rel).strip() or default_rel
    p = Path(raw).expanduser()
    if p.is_absolute():
        return p.resolve()
    posix = p.as_posix().lstrip("./")
    if posix.startswith("data/memory/"):
        posix = posix[len("data/memory/") :]
    elif posix == "data/memory":
        posix = ""
    base = memory_dir(server_root, config)
    return (base / posix).resolve() if posix else base.resolve()


def apply_resolved_memory_paths(config: dict[str, Any], server_root: Path) -> None:
    """Rewrite relative memory.* paths in-place so Hub/Chroma honour NEYRA_DATA_DIR."""
    if not isinstance(config, dict):
        return
    mem = config.get("memory")
    if not isinstance(mem, dict):
        mem = {}
        config["memory"] = mem

    defaults = {
        "sqlite_path": "./data/memory/neyra_memory.db",
        "chroma_db_path": "./data/memory/chroma_db",
        "journal_path": "./data/memory/journal.json",
        "diary_path": "./data/memory/neyra_diary.jsonl",
        "thoughts_log": "./data/memory/thoughts.log",
    }
    for key in _MEMORY_PATH_KEYS:
        mem[key] = str(
            resolve_memory_path(server_root, config, mem.get(key), defaults.get(key, "./data/memory"))
        )

    nested_defaults = {
        ("ltm_consolidation", "log_dir"): "./data/memory/ltm_consolidation",
        ("working_memory", "storage_dir"): "./data/memory/working_memory",
        ("working_memory", "shared_file_path"): "./data/memory/working_memory.md",
    }
    for section, keys in _MEMORY_NESTED_PATH_KEYS.items():
        block = mem.get(section)
        if not isinstance(block, dict):
            block = {}
            mem[section] = block
        for key in keys:
            default = nested_defaults.get((section, key), "./data/memory")
            block[key] = str(resolve_memory_path(server_root, config, block.get(key), default))


def ensure_runtime_dirs(server_root: Path, config: dict[str, Any] | None = None) -> None:
    data = resolve_data_dir(server_root, config)
    (data / "memory").mkdir(parents=True, exist_ok=True)
    (data / "memory" / "chroma_db").mkdir(parents=True, exist_ok=True)
    (server_root / "logs").mkdir(parents=True, exist_ok=True)
    (server_root / "sounds").mkdir(parents=True, exist_ok=True)
