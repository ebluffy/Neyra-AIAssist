"""Offline: BackupManager restore matches real run_backup archive layout (AR-34/38/42)."""

from __future__ import annotations

import os
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

            db.write_text("live-db-changed", encoding="utf-8")
            (chroma / "marker.txt").write_text("live-chroma-changed", encoding="utf-8")
            (mem / "neyra_memory.db-wal").write_text("wal-live", encoding="utf-8")
            (logs / "api_audit.jsonl").write_text(
                '{"event":"keep-me"}\n{"event":"after-backup"}\n',
                encoding="utf-8",
            )

            prepared = mgr.prepare_restore(archive_name)
            assert prepared.get("pending") is True
            assert db.read_text(encoding="utf-8") == "live-db-changed"
            assert (chroma / "marker.txt").read_text(encoding="utf-8") == "live-chroma-changed"

            out = mgr.apply_pending_restore()
            assert out is not None and out.get("applied") is True
        finally:
            os.chdir(cwd)

        assert out["memory_root"] == str(mem)
        assert out.get("logs_restored") is False
        assert db.read_text(encoding="utf-8") == "original-db"
        assert (chroma / "marker.txt").read_text(encoding="utf-8") == "original-chroma"
        audit = (logs / "api_audit.jsonl").read_text(encoding="utf-8")
        assert "after-backup" in audit
        assert "keep-me" in audit
    finally:
        td.cleanup()


def test_restore_nonstandard_chroma_parent_name() -> None:
    """AR-42: chroma under .../vectors/chroma_db still restores via archive memory/."""
    from core.runtime.backup import BackupManager

    td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    try:
        base = Path(td.name)
        vectors = base / "data" / "vectors"
        vectors.mkdir(parents=True)
        chroma = vectors / "chroma_db"
        chroma.mkdir()
        (chroma / "marker.txt").write_text("vec-chroma", encoding="utf-8")
        db = vectors / "neyra_memory.db"
        db.write_text("vec-db", encoding="utf-8")
        backups = base / "backups"
        backups.mkdir()
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
            bak = mgr.run_backup("vectors")
            name = Path(str(bak["archive"])).name
            (chroma / "marker.txt").write_text("changed", encoding="utf-8")
            db.write_text("changed-db", encoding="utf-8")
            mgr.restore_backup(name)
        finally:
            os.chdir(cwd)
        assert (chroma / "marker.txt").read_text(encoding="utf-8") == "vec-chroma"
        assert db.read_text(encoding="utf-8") == "vec-db"
    finally:
        td.cleanup()


def test_restore_external_sqlite_clears_live_wal() -> None:
    """AR-42: external sqlite_path drops live -wal/-shm even if archive has no wal."""
    from core.runtime.backup import BackupManager
    import zipfile

    td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    try:
        base = Path(td.name)
        mem = base / "memory"
        mem.mkdir()
        chroma = mem / "chroma_db"
        chroma.mkdir()
        (chroma / "x.txt").write_text("c", encoding="utf-8")
        ext_db = base / "elsewhere" / "hub.db"
        ext_db.parent.mkdir(parents=True)
        ext_db.write_text("live", encoding="utf-8")
        Path(str(ext_db) + "-wal").write_text("stale-wal", encoding="utf-8")
        Path(str(ext_db) + "-shm").write_text("stale-shm", encoding="utf-8")

        backups = base / "backups"
        backups.mkdir()
        staging = base / "staging"
        (staging / "memory" / "chroma_db").mkdir(parents=True)
        (staging / "memory" / "chroma_db" / "x.txt").write_text("from-bak", encoding="utf-8")
        (staging / "data" / "memory").mkdir(parents=True)
        (staging / "data" / "memory" / "hub.db").write_text("restored", encoding="utf-8")
        # No -wal in archive on purpose.
        (staging / "backup_manifest.json").write_text("{}", encoding="utf-8")
        zip_path = backups / "neyra-backup-ext.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            for p in staging.rglob("*"):
                if p.is_file():
                    zf.write(p, p.relative_to(staging).as_posix())

        cfg = {
            "backup": {"local_dir": str(backups)},
            "memory": {
                "chroma_db_path": str(chroma),
                "sqlite_path": str(ext_db),
            },
        }
        mgr = BackupManager(cfg)
        cwd = Path.cwd()
        try:
            os.chdir(base)
            mgr.restore_backup("neyra-backup-ext.zip")
        finally:
            os.chdir(cwd)
        assert ext_db.read_text(encoding="utf-8") == "restored"
        assert not Path(str(ext_db) + "-wal").exists()
        assert not Path(str(ext_db) + "-shm").exists()
        assert (chroma / "x.txt").read_text(encoding="utf-8") == "from-bak"
    finally:
        td.cleanup()


def test_apply_pending_restore_rolls_back_on_copy_failure() -> None:
    """AR-43: failing copytree leaves live memory and keeps pending staging."""
    from unittest import mock

    from core.runtime.backup import BackupManager, PENDING_DIR_NAME, PENDING_FLAG, PENDING_MEMORY

    td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    try:
        base = Path(td.name)
        mem = base / "memory"
        mem.mkdir()
        (mem / "keep.txt").write_text("alive", encoding="utf-8")
        chroma = mem / "chroma_db"
        chroma.mkdir()
        (chroma / "x.txt").write_text("c", encoding="utf-8")
        backups = base / "backups"
        backups.mkdir()
        cfg = {
            "backup": {"local_dir": str(backups)},
            "memory": {
                "chroma_db_path": str(chroma),
                "sqlite_path": str(mem / "neyra_memory.db"),
            },
        }
        (mem / "neyra_memory.db").write_text("db", encoding="utf-8")
        mgr = BackupManager(cfg)
        cwd = Path.cwd()
        try:
            os.chdir(base)
            bak = mgr.run_backup("seed")
            name = Path(str(bak["archive"])).name
            (mem / "keep.txt").write_text("changed", encoding="utf-8")
            mgr.prepare_restore(name)
            pending = base / PENDING_DIR_NAME
            assert (pending / PENDING_FLAG).is_file()
            assert (pending / PENDING_MEMORY).is_dir()

            real_copytree = __import__("shutil").copytree

            def _boom(src, dst, *a, **k):
                raise OSError("disk full")

            with mock.patch("shutil.copytree", side_effect=_boom):
                out = mgr.apply_pending_restore()
            assert out is not None and out.get("applied") is False
            assert out.get("pending") is True
            assert (mem / "keep.txt").read_text(encoding="utf-8") == "changed"
            assert (pending / PENDING_FLAG).is_file()
            assert (pending / PENDING_MEMORY).is_dir()
            last = mgr.read_last_apply_result()
            assert last is not None and last.get("status") == "failed"
            # Successful apply still works after a failed attempt.
            with mock.patch("shutil.copytree", real_copytree):
                ok = mgr.apply_pending_restore()
            assert ok is not None and ok.get("applied") is True
            assert (mem / "keep.txt").read_text(encoding="utf-8") == "alive"
            assert not pending.exists()
            last2 = mgr.read_last_apply_result()
            assert last2 is not None and last2.get("status") == "applied"
        finally:
            os.chdir(cwd)
    finally:
        td.cleanup()


def test_apply_rolls_back_when_external_db_copy_fails() -> None:
    """AR-47: copy2 failure after tree swap restores memory and leaves no aside orphan."""
    from unittest import mock

    from core.runtime.backup import BackupManager, PENDING_DIR_NAME, PENDING_FLAG

    td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    try:
        base = Path(td.name)
        mem = base / "memory"
        mem.mkdir()
        (mem / "keep.txt").write_text("alive", encoding="utf-8")
        chroma = mem / "chroma_db"
        chroma.mkdir()
        (chroma / "x.txt").write_text("c", encoding="utf-8")
        ext_db = base / "elsewhere" / "hub.db"
        ext_db.parent.mkdir(parents=True)
        ext_db.write_text("live-db", encoding="utf-8")
        Path(str(ext_db) + "-wal").write_text("live-wal", encoding="utf-8")
        backups = base / "backups"
        backups.mkdir()
        cfg = {
            "backup": {"local_dir": str(backups)},
            "memory": {"chroma_db_path": str(chroma), "sqlite_path": str(ext_db)},
        }
        mgr = BackupManager(cfg)
        cwd = Path.cwd()
        try:
            os.chdir(base)
            bak = mgr.run_backup("seed")
            name = Path(str(bak["archive"])).name
            (mem / "keep.txt").write_text("changed", encoding="utf-8")
            ext_db.write_text("changed-db", encoding="utf-8")
            mgr.prepare_restore(name)

            def _boom_copy2(src, dst, *a, **k):
                raise OSError("copy2 failed")

            with mock.patch("shutil.copy2", side_effect=_boom_copy2):
                out = mgr.apply_pending_restore()
            assert out is not None and out.get("applied") is False
            assert (mem / "keep.txt").read_text(encoding="utf-8") == "changed"
            assert ext_db.read_text(encoding="utf-8") == "changed-db"
            assert Path(str(ext_db) + "-wal").read_text(encoding="utf-8") == "live-wal"
            orphans = list(mem.parent.glob("memory.pre-restore-*"))
            assert orphans == [], f"aside orphans left: {orphans}"
            assert (base / PENDING_DIR_NAME / PENDING_FLAG).is_file()
        finally:
            os.chdir(cwd)
    finally:
        td.cleanup()


def test_external_sqlite_without_db_keeps_live_wal() -> None:
    """AR-46: no .db in archive → do not delete live -wal/-shm."""
    from core.runtime.backup import BackupManager
    import zipfile

    td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    try:
        base = Path(td.name)
        mem = base / "memory"
        mem.mkdir()
        chroma = mem / "chroma_db"
        chroma.mkdir()
        (chroma / "x.txt").write_text("c", encoding="utf-8")
        ext_db = base / "elsewhere" / "hub.db"
        ext_db.parent.mkdir(parents=True)
        ext_db.write_text("live-db", encoding="utf-8")
        Path(str(ext_db) + "-wal").write_text("keep-wal", encoding="utf-8")
        backups = base / "backups"
        backups.mkdir()
        staging = base / "staging"
        (staging / "memory" / "chroma_db").mkdir(parents=True)
        (staging / "memory" / "chroma_db" / "x.txt").write_text("from-bak", encoding="utf-8")
        (staging / "data" / "memory").mkdir(parents=True)
        # No hub.db in archive
        (staging / "backup_manifest.json").write_text("{}", encoding="utf-8")
        zip_path = backups / "neyra-backup-nodb.zip"
        with zipfile.ZipFile(zip_path, "w") as zf:
            for p in staging.rglob("*"):
                if p.is_file():
                    zf.write(p, p.relative_to(staging).as_posix())
        cfg = {
            "backup": {"local_dir": str(backups)},
            "memory": {"chroma_db_path": str(chroma), "sqlite_path": str(ext_db)},
        }
        mgr = BackupManager(cfg)
        cwd = Path.cwd()
        try:
            os.chdir(base)
            mgr.restore_backup("neyra-backup-nodb.zip")
        finally:
            os.chdir(cwd)
        assert ext_db.read_text(encoding="utf-8") == "live-db"
        assert Path(str(ext_db) + "-wal").read_text(encoding="utf-8") == "keep-wal"
    finally:
        td.cleanup()


def test_restore_refuses_parent_of_backup_dir() -> None:
    from core.runtime.backup import BackupManager

    td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    try:
        base = Path(td.name)
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


def test_swap_inner_rollback_failure_is_rollback_failed() -> None:
    """AR-47: copytree fail + rmtree no-op → rollback_failed with aside_path."""
    from unittest import mock

    from core.runtime.backup import BackupManager, PENDING_BLOCKED, PENDING_DIR_NAME

    td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    try:
        base = Path(td.name)
        mem = base / "memory"
        mem.mkdir()
        (mem / "keep.txt").write_text("alive", encoding="utf-8")
        chroma = mem / "chroma_db"
        chroma.mkdir()
        (chroma / "x.txt").write_text("c", encoding="utf-8")
        db = mem / "neyra_memory.db"
        db.write_text("db", encoding="utf-8")
        backups = base / "backups"
        backups.mkdir()
        cfg = {
            "backup": {"local_dir": str(backups)},
            "memory": {"chroma_db_path": str(chroma), "sqlite_path": str(db)},
        }
        mgr = BackupManager(cfg)
        cwd = Path.cwd()
        try:
            os.chdir(base)
            bak = mgr.run_backup("seed")
            name = Path(str(bak["archive"])).name
            (mem / "keep.txt").write_text("changed", encoding="utf-8")
            mgr.prepare_restore(name)

            def _partial_copytree(src, dst, *a, **k):
                Path(dst).mkdir(parents=True, exist_ok=True)
                (Path(dst) / "partial.txt").write_text("half", encoding="utf-8")
                raise OSError("copytree failed midway")

            def _noop_rmtree(path, *a, **k):
                return None

            with mock.patch("shutil.copytree", side_effect=_partial_copytree):
                with mock.patch("shutil.rmtree", side_effect=_noop_rmtree):
                    out = mgr.apply_pending_restore()
            assert out is not None
            assert out.get("status") == "rollback_failed"
            assert out.get("aside_path")
            aside = Path(str(out["aside_path"]))
            assert aside.is_dir()
            assert (aside / "keep.txt").read_text(encoding="utf-8") == "changed"
            assert (base / PENDING_DIR_NAME / PENDING_BLOCKED).is_file()
            # Second call must not re-apply (AR-52).
            again = mgr.apply_pending_restore()
            assert again is not None and again.get("status") == "rollback_failed"
            assert again.get("blocked") is True
        finally:
            os.chdir(cwd)
    finally:
        td.cleanup()


def test_external_db_rollback_after_os_replace_wal_fail() -> None:
    """AR-51: copy2 fails on -wal after os.replace → live db/wal restored, no orphans."""
    from unittest import mock

    from core.runtime.backup import BackupManager, PENDING_DIR_NAME, PENDING_FLAG

    td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    try:
        base = Path(td.name)
        mem = base / "memory"
        mem.mkdir()
        (mem / "keep.txt").write_text("alive", encoding="utf-8")
        chroma = mem / "chroma_db"
        chroma.mkdir()
        (chroma / "x.txt").write_text("c", encoding="utf-8")
        ext_db = base / "elsewhere" / "hub.db"
        ext_db.parent.mkdir(parents=True)
        ext_db.write_text("live-db", encoding="utf-8")
        Path(str(ext_db) + "-wal").write_text("live-wal", encoding="utf-8")
        backups = base / "backups"
        backups.mkdir()
        cfg = {
            "backup": {"local_dir": str(backups)},
            "memory": {"chroma_db_path": str(chroma), "sqlite_path": str(ext_db)},
        }
        mgr = BackupManager(cfg)
        cwd = Path.cwd()
        try:
            os.chdir(base)
            bak = mgr.run_backup("seed")
            name = Path(str(bak["archive"])).name
            (mem / "keep.txt").write_text("changed", encoding="utf-8")
            ext_db.write_text("changed-db", encoding="utf-8")
            Path(str(ext_db) + "-wal").write_text("changed-wal", encoding="utf-8")
            mgr.prepare_restore(name)
            # Ensure staged memory has -wal so place_sqlite copies it after os.replace.
            from core.runtime.backup import PENDING_MEMORY

            staged_wal = base / PENDING_DIR_NAME / PENDING_MEMORY / "hub.db-wal"
            staged_wal.write_text("bak-wal", encoding="utf-8")

            real_copy2 = __import__("shutil").copy2

            def _boom_wal_copy2(src, dst, *a, **k):
                if str(dst).endswith("-wal") or str(src).endswith("-wal"):
                    raise OSError("wal copy2 failed")
                return real_copy2(src, dst, *a, **k)

            with mock.patch("shutil.copy2", side_effect=_boom_wal_copy2):
                out = mgr.apply_pending_restore()
            assert out is not None and out.get("applied") is False
            assert (mem / "keep.txt").read_text(encoding="utf-8") == "changed"
            assert ext_db.read_text(encoding="utf-8") == "changed-db"
            assert Path(str(ext_db) + "-wal").read_text(encoding="utf-8") == "changed-wal"
            orphans = list(ext_db.parent.glob("*.pre-restore-*"))
            assert orphans == [], f"sqlite aside orphans: {orphans}"
            mem_orphans = list(mem.parent.glob("memory.pre-restore-*"))
            assert mem_orphans == [], f"memory aside orphans: {mem_orphans}"
            assert (base / PENDING_DIR_NAME / PENDING_FLAG).is_file()
        finally:
            os.chdir(cwd)
    finally:
        td.cleanup()


def test_sqlite_rename_fail_on_wal_keeps_live_wal() -> None:
    """AR-54: rename fail on -wal must not unlink the live WAL."""
    from unittest import mock

    from core.runtime.backup import BackupManager, PENDING_DIR_NAME, PENDING_FLAG

    td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    try:
        base = Path(td.name)
        mem = base / "memory"
        mem.mkdir()
        (mem / "keep.txt").write_text("alive", encoding="utf-8")
        chroma = mem / "chroma_db"
        chroma.mkdir()
        (chroma / "x.txt").write_text("c", encoding="utf-8")
        ext_db = base / "elsewhere" / "hub.db"
        ext_db.parent.mkdir(parents=True)
        ext_db.write_text("live-db", encoding="utf-8")
        wal = Path(str(ext_db) + "-wal")
        wal.write_text("live-wal", encoding="utf-8")
        backups = base / "backups"
        backups.mkdir()
        cfg = {
            "backup": {"local_dir": str(backups)},
            "memory": {"chroma_db_path": str(chroma), "sqlite_path": str(ext_db)},
        }
        mgr = BackupManager(cfg)
        cwd = Path.cwd()
        try:
            os.chdir(base)
            bak = mgr.run_backup("seed")
            name = Path(str(bak["archive"])).name
            (mem / "keep.txt").write_text("changed", encoding="utf-8")
            ext_db.write_text("changed-db", encoding="utf-8")
            wal.write_text("live-wal", encoding="utf-8")
            mgr.prepare_restore(name)

            real_rename = Path.rename

            def _rename(self: Path, target, *a, **k):
                if self.name.endswith("-wal") or str(self).endswith("-wal"):
                    raise OSError("wal locked")
                return real_rename(self, target, *a, **k)

            with mock.patch.object(Path, "rename", _rename):
                out = mgr.apply_pending_restore()
            assert out is not None and out.get("applied") is False
            assert out.get("status") == "failed"
            assert ext_db.read_text(encoding="utf-8") == "changed-db"
            assert wal.read_text(encoding="utf-8") == "live-wal"
            orphans = list(ext_db.parent.glob("*.pre-restore-*"))
            assert orphans == [], f"sqlite aside orphans: {orphans}"
            assert (base / PENDING_DIR_NAME / PENDING_FLAG).is_file()
        finally:
            os.chdir(cwd)
    finally:
        td.cleanup()


def test_sqlite_rollback_failed_records_db_aside_paths() -> None:
    """AR-55: SqliteRollbackError must record existing *.db.pre-restore-* paths."""
    from unittest import mock

    from core.runtime.backup import (
        BackupManager,
        PENDING_BLOCKED,
        PENDING_DIR_NAME,
        PENDING_MEMORY,
    )

    td = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    try:
        base = Path(td.name)
        mem = base / "memory"
        mem.mkdir()
        (mem / "keep.txt").write_text("alive", encoding="utf-8")
        chroma = mem / "chroma_db"
        chroma.mkdir()
        (chroma / "x.txt").write_text("c", encoding="utf-8")
        ext_db = base / "elsewhere" / "hub.db"
        ext_db.parent.mkdir(parents=True)
        ext_db.write_text("live-db", encoding="utf-8")
        wal = Path(str(ext_db) + "-wal")
        wal.write_text("live-wal", encoding="utf-8")
        backups = base / "backups"
        backups.mkdir()
        cfg = {
            "backup": {"local_dir": str(backups)},
            "memory": {"chroma_db_path": str(chroma), "sqlite_path": str(ext_db)},
        }
        mgr = BackupManager(cfg)
        cwd = Path.cwd()
        try:
            os.chdir(base)
            bak = mgr.run_backup("seed")
            name = Path(str(bak["archive"])).name
            (mem / "keep.txt").write_text("changed", encoding="utf-8")
            ext_db.write_text("changed-db", encoding="utf-8")
            wal.write_text("changed-wal", encoding="utf-8")
            mgr.prepare_restore(name)
            (base / PENDING_DIR_NAME / PENDING_MEMORY / "hub.db-wal").write_text(
                "bak-wal", encoding="utf-8"
            )

            real_copy2 = __import__("shutil").copy2
            real_rename = Path.rename
            phase = {"after_replace": False}

            def _boom_wal_copy2(src, dst, *a, **k):
                if str(dst).endswith("-wal") or str(src).endswith("-wal"):
                    phase["after_replace"] = True
                    raise OSError("wal copy2 failed")
                return real_copy2(src, dst, *a, **k)

            def _rename(self: Path, target, *a, **k):
                # After os.replace, refuse to put live db back from aside.
                if (
                    phase["after_replace"]
                    and self.name.startswith("hub.db.pre-restore-")
                    and not self.name.endswith(("-wal", "-shm"))
                    and Path(target).name == "hub.db"
                ):
                    raise OSError("cannot restore db aside")
                return real_rename(self, target, *a, **k)

            with mock.patch("shutil.copy2", side_effect=_boom_wal_copy2):
                with mock.patch.object(Path, "rename", _rename):
                    out = mgr.apply_pending_restore()
            assert out is not None
            assert out.get("status") == "rollback_failed"
            paths = out.get("sqlite_aside_paths") or []
            assert paths, f"expected sqlite_aside_paths, got {out}"
            assert any(Path(p).exists() and "hub.db.pre-restore-" in p for p in paths)
            # Memory was rolled back — aside_path should be empty or gone.
            mem_aside = str(out.get("aside_path") or "")
            assert not mem_aside or not Path(mem_aside).exists()
            blocked = base / PENDING_DIR_NAME / PENDING_BLOCKED
            assert blocked.is_file()
            import json

            raw = json.loads(blocked.read_text(encoding="utf-8"))
            assert any(
                Path(p).exists() and "hub.db.pre-restore-" in p
                for p in (raw.get("sqlite_aside_paths") or [])
            )
        finally:
            os.chdir(cwd)
    finally:
        td.cleanup()


if __name__ == "__main__":
    test_restore_from_real_run_backup()
    test_restore_nonstandard_chroma_parent_name()
    test_restore_external_sqlite_clears_live_wal()
    test_apply_pending_restore_rolls_back_on_copy_failure()
    test_apply_rolls_back_when_external_db_copy_fails()
    test_external_sqlite_without_db_keeps_live_wal()
    test_restore_refuses_parent_of_backup_dir()
    test_swap_inner_rollback_failure_is_rollback_failed()
    test_external_db_rollback_after_os_replace_wal_fail()
    test_sqlite_rename_fail_on_wal_keeps_live_wal()
    test_sqlite_rollback_failed_records_db_aside_paths()
    print("OK test_backup_restore_offline")
