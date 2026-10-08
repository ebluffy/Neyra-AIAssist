"""Offline: BackupManager restore targets memory root (not hardcoded ./data/memory only)."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_restore_uses_chroma_parent() -> None:
    from core.runtime.backup import BackupManager

    td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    try:
        base = Path(td.name)
        data_dir = base / "custom_data"
        mem = data_dir / "memory"
        mem.mkdir(parents=True)
        chroma = mem / "chroma_db"
        chroma.mkdir()
        (chroma / "marker.txt").write_text("live", encoding="utf-8")
        db = mem / "neyra_memory.db"
        db.write_text("live-db", encoding="utf-8")
        (mem / "neyra_memory.db-wal").write_text("stale-wal", encoding="utf-8")

        backups = base / "backups"
        backups.mkdir()
        staging = base / "staging"
        arch_mem = staging / "data" / "memory"
        arch_mem.mkdir(parents=True)
        (arch_mem / "neyra_memory.db").write_text("restored-db", encoding="utf-8")
        (arch_mem / "chroma_db").mkdir()
        (arch_mem / "chroma_db" / "marker.txt").write_text("from-backup", encoding="utf-8")
        (staging / "backup_manifest.json").write_text("{}", encoding="utf-8")
        zip_path = backups / "neyra-backup-test.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            for p in staging.rglob("*"):
                if p.is_file():
                    zf.write(p, p.relative_to(staging).as_posix())

        cfg = {
            "backup": {"local_dir": str(backups)},
            "memory": {
                "chroma_db_path": str(chroma),
                "sqlite_path": str(db),
            },
        }
        mgr = BackupManager(cfg)
        # Work from base so relative ./logs resolve under a writable tree
        cwd = Path.cwd()
        try:
            import os

            os.chdir(base)
            out = mgr.restore_backup("neyra-backup-test.zip")
        finally:
            os.chdir(cwd)

        assert out["memory_root"] == str(mem)
        assert db.read_text(encoding="utf-8") == "restored-db"
        assert (chroma / "marker.txt").read_text(encoding="utf-8") == "from-backup"
        assert not (mem / "neyra_memory.db-wal").exists()
    finally:
        td.cleanup()


if __name__ == "__main__":
    test_restore_uses_chroma_parent()
    print("OK test_backup_restore_offline")
