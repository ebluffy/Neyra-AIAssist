"""Reproducible backup/restore smoke using only an explicitly supplied DB copy.

Never pass a running server database. The script copies the supplied SQLite file
with SQLite's backup API into a private temporary workspace before opening Neyra
code, then migrates, backs up, mutates, restores, and verifies only that workspace.
"""

from __future__ import annotations

import argparse
import os
import sqlite3
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.memory.sqlite_store import SqliteStore  # noqa: E402
from core.runtime.backup import BackupManager  # noqa: E402


def _integrity(db_path: Path) -> str:
    with sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True) as conn:
        return str(conn.execute("PRAGMA integrity_check").fetchone()[0])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite-copy", required=True, type=Path,
                        help="path to a closed/private copy of the SQLite database")
    parser.add_argument("--i-confirm-this-is-a-copy", action="store_true",
                        help="required guard: input is not the live server database")
    args = parser.parse_args()
    source = args.sqlite_copy.expanduser().resolve()
    if not args.i_confirm_this_is_a_copy:
        parser.error("refusing to run without --i-confirm-this-is-a-copy")
    if not source.is_file():
        parser.error("SQLite copy does not exist or is not a regular file")

    with tempfile.TemporaryDirectory(prefix="neyra-pr65-copy-smoke-") as temp:
        root = Path(temp)
        memory = root / "data" / "memory"
        chroma = memory / "chroma_db"
        backups = root / "backups"
        logs = root / "logs"
        project = root / "project"
        for directory in (chroma, backups, logs, project / "logs", project / "modules"):
            directory.mkdir(parents=True, exist_ok=True)
        db_copy = memory / "neyra_memory.db"
        src = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=30)
        try:
            dst = sqlite3.connect(str(db_copy))
            try:
                src.backup(dst)
            finally:
                dst.close()
        finally:
            src.close()

        store = SqliteStore(db_copy)
        schema_version = store.schema_version()
        store.close()
        if _integrity(db_copy) != "ok":
            raise RuntimeError("copied SQLite database failed integrity_check after migration")

        marker = chroma / "restore-probe.txt"
        marker.write_text("before", encoding="utf-8")
        config = {
            "backup": {"local_dir": str(backups)},
            "memory": {"sqlite_path": str(db_copy), "chroma_db_path": str(chroma)},
            "api": {"auth_required": True, "state_dir": str(root / "state")},
        }
        manager = BackupManager(config)
        old_cwd = Path.cwd()
        try:
            os.chdir(root)
            archive = Path(manager.run_backup("pr65_copy_smoke")["archive"])
            db = sqlite3.connect(str(db_copy))
            try:
                db.execute("CREATE TABLE pr65_restore_probe (value TEXT NOT NULL)")
                db.execute("INSERT INTO pr65_restore_probe VALUES ('temporary mutation')")
                db.commit()
            finally:
                db.close()
            marker.write_text("after", encoding="utf-8")
            manager.prepare_restore(archive.name)
            applied = manager.apply_pending_restore()
        finally:
            os.chdir(old_cwd)

        if not applied or not applied.get("applied"):
            raise RuntimeError("BackupManager did not apply the pending restore")
        with sqlite3.connect(db_copy.as_uri() + "?mode=ro", uri=True) as conn:
            probe_exists = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='pr65_restore_probe'"
            ).fetchone()
        if probe_exists or _integrity(db_copy) != "ok" or marker.read_text(encoding="utf-8") != "before":
            raise RuntimeError("restored copy did not match its pre-mutation state")
        if not archive.is_file():
            raise RuntimeError("backup archive was not retained")
        print(f"PASS schema_version={schema_version} backup_restore=ok sqlite_integrity=ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
