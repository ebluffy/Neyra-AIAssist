"""Resolve server data directory (paths.data_dir, NEYRA_DATA_DIR)."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any


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


def ensure_runtime_dirs(server_root: Path, config: dict[str, Any] | None = None) -> None:
    data = resolve_data_dir(server_root, config)
    (data / "memory").mkdir(parents=True, exist_ok=True)
    (data / "memory" / "chroma_db").mkdir(parents=True, exist_ok=True)
    (server_root / "logs").mkdir(parents=True, exist_ok=True)
    (server_root / "sounds").mkdir(parents=True, exist_ok=True)
