"""Offline: BackupManager restore matches real run_backup archive layout (AR-34/38)."""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_restore_from_real_run_backup() -> None:
    """Archive from run_backup() must restore both Hub DB and chroma_db."""
    from core.runtime.backup import BackupManager

    td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    try:
        base = Path(td.name)
        data_dir = base / "custom_data"
        mem = data_dir / "memory"
        mem.mkdir(parents=True)
        chroma = mem / "chroma_db"
        chroma.mkdir()
        (chroma / "marker.txt").write_text("original-chroma", encoding="utf-8")
        db = mem / "neyra_memory.db"
        db.write_text("original-db", encoding="utf-8")
        (mem / "neyra_memory.db-wal").write_text("wal-v1", encoding="utf-8")

        backups = base / "backups"
        backups.mkdir()
        logs = base / "logs"
        logs.mkdir()
        (logs / "api_audit.jsonl").write_text('{"event":"keep-me"}\n', encoding="utf-8")

        cfg = {
            "backup": {"local_dir": str(backups)},
            "memory": {
                "chroma_db_path": str(chroma),
                "sqlite_path": str(db),
            },
        }
        mgr = BackupManager(cfg)
        cwd = Path.cwd()
        try:
            os.chdir(base)
            out_bak = mgr.run_backup("test_seed")
            archive_path = Path(str(out_bak["archive"]))
            assert archive_path.is_file()
            archive_name = archive_path.name

            # Mutate live state after backup
            db.write_text("live-db-changed", encoding="utf-8")
            (chroma / "marker.txt").write_text("live-chroma-changed", encoding="utf-8")
            (mem / "neyra_memory.db-wal").write_text("wal-live", encoding="utf-8")
            (logs / "api_audit.jsonl").write_text(
                '{"event":"keep-me"}\n{"event":"after-backup"}\n',
                encoding="utf-8",
            )

            out = mgr.restore_backup(archive_name)
        finally:
            os.chdir(cwd)

        assert out["memory_root"] == str(mem)
        assert out.get("logs_restored") is False
        assert db.read_text(encoding="utf-8") == "original-db"
        assert (chroma / "marker.txt").read_text(encoding="utf-8") == "original-chroma"
        # WAL from archive may be restored under memory/; live-only WAL must not linger alone.
        # Critical: chroma must exist (AR-38) and audit log must not be wiped (AR-34).
        audit = (logs / "api_audit.jsonl").read_text(encoding="utf-8")
        assert "after-backup" in audit
        assert "keep-me" in audit
    finally:
        td.cleanup()


def test_restore_refuses_parent_of_backup_dir() -> None:
    from core.runtime.backup import BackupManager

    td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    try:
        base = Path(td.name)
        # chroma parent == base, backups under base → restore would wipe archives
        chroma = base / "chroma_db"
        chroma.mkdir()
        backups = base / "backups"
        backups.mkdir()
        (backups / "neyra-backup-x.zip").write_bytes(b"PK\x05\x06" + b"\x00" * 18)
        cfg = {
            "backup": {"local_dir": str(backups)},
            "memory": {
                "chroma_db_path": str(chroma),
                "sqlite_path": str(base / "neyra_memory.db"),
            },
        }
        mgr = BackupManager(cfg)
        try:
            mgr._assert_safe_memory_dst(mgr._memory_root())
            raise AssertionError("expected ValueError for unsafe memory root")
        except ValueError:
            pass
    finally:
        td.cleanup()


if __name__ == "__main__":
    test_restore_from_real_run_backup()
    test_restore_refuses_parent_of_backup_dir()
    print("OK test_backup_restore_offline")
