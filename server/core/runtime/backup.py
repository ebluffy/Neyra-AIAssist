"""
Backup/restore manager with external storage sync.

Restore from the API only stages a pending swap; the live Hub/Chroma trees are
replaced at process start via ``apply_pending_restore`` (before Memory Hub opens).
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from datetime import datetime
from pathlib import Path

from core.runtime.external_storage import ExternalStorageAdapter, build_external_storage_adapter

logger = logging.getLogger("neyra.backup")

PENDING_DIR_NAME = ".neyra_pending_restore"
PENDING_FLAG = "pending.json"
PENDING_MEMORY = "memory"
LAST_APPLY_NAME = "last_restore_apply.json"


class BackupManager:
    def __init__(self, config: dict):
        self.config = config or {}
        bcfg = self.config.get("backup") or {}
        self.local_dir = Path(str(bcfg.get("local_dir") or "./backups"))
        self.local_dir.mkdir(parents=True, exist_ok=True)
        self.sources = [Path("./data/memory"), Path("./logs")]
        mem = self.config.get("memory") if isinstance(self.config.get("memory"), dict) else {}
        # Prefer resolved absolute memory root when apply_resolved_memory_paths ran.
        chroma = Path(str(mem.get("chroma_db_path") or "./data/memory/chroma_db"))
        if chroma.is_absolute():
            self.sources = [chroma.parent, Path("./logs")]
        self.external_adapter: ExternalStorageAdapter | None = build_external_storage_adapter(self.config)

    def _pending_root(self) -> Path:
        return Path("./") / PENDING_DIR_NAME

    def _sqlite_paths(self) -> list[Path]:
        """Explicit Memory Hub DB (+ WAL/SHM) so backup never misses them."""
        mem = self.config.get("memory") if isinstance(self.config.get("memory"), dict) else {}
        db = Path(str(mem.get("sqlite_path") or "./data/memory/neyra_memory.db"))
        out = [db, Path(str(db) + "-wal"), Path(str(db) + "-shm")]
        return out

    def run_backup(self, reason: str = "manual") -> dict:
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        archive_base = self.local_dir / f"neyra-backup-{ts}"
        tmp_root = Path("./.tmp_backup_staging")
        if tmp_root.exists():
            shutil.rmtree(tmp_root, ignore_errors=True)
        tmp_root.mkdir(parents=True, exist_ok=True)
        # Always store the memory tree as archive "memory/" (AR-42), regardless of folder name.
        for p in self.sources:
            if not p.exists():
                continue
            if p.name == "logs" or str(p).replace("\\", "/").endswith("/logs"):
                dst = tmp_root / "logs"
            else:
                dst = tmp_root / "memory"
            if p.is_dir():
                shutil.copytree(p, dst, dirs_exist_ok=True)
            else:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(p, dst)
        # Ensure Hub SQLite (+ wal/shm) and note chroma path in manifest
        mem_dir = tmp_root / "data" / "memory"
        mem_dir.mkdir(parents=True, exist_ok=True)
        copied_db: list[str] = []
        for p in self._sqlite_paths():
            if p.exists() and p.is_file():
                shutil.copy2(p, mem_dir / p.name)
                copied_db.append(p.name)
        mem = self.config.get("memory") if isinstance(self.config.get("memory"), dict) else {}
        chroma = Path(str(mem.get("chroma_db_path") or "./data/memory/chroma_db"))
        manifest = {
            "reason": reason,
            "sqlite_files": copied_db,
            "sqlite_path": str(mem.get("sqlite_path") or "./data/memory/neyra_memory.db"),
            "chroma_db_path": str(chroma),
            "memory_archive_dir": "memory",
            "rag_write_mode": mem.get("rag_write_mode"),
        }
        (tmp_root / "backup_manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        zip_path = Path(shutil.make_archive(str(archive_base), "zip", root_dir=str(tmp_root)))
        shutil.rmtree(tmp_root, ignore_errors=True)
        external_ref = None
        if self.external_adapter is not None:
            try:
                external_ref = self.external_adapter.upload_file(zip_path, zip_path.name)
            except Exception as e:
                logger.warning("External backup upload failed: %s", e)
        return {
            "archive": str(zip_path),
            "external_ref": external_ref,
            "reason": reason,
            "sqlite_files": copied_db,
            "chroma_db_path": str(chroma),
        }

    def list_backups(self) -> list[dict]:
        """Local zip archives in backup.local_dir (newest first)."""
        rows: list[dict] = []
        if not self.local_dir.is_dir():
            return rows
        for p in sorted(self.local_dir.glob("neyra-backup-*.zip"), key=lambda x: x.name, reverse=True):
            if not p.is_file():
                continue
            st = p.stat()
            rows.append(
                {
                    "name": p.name,
                    "path": str(p),
                    "bytes": int(st.st_size),
                    "mtime": datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
                }
            )
        return rows

    def _memory_root(self) -> Path:
        """Same root backup uses when chroma path is absolute (data_dir / NEYRA_DATA_DIR)."""
        mem = self.config.get("memory") if isinstance(self.config.get("memory"), dict) else {}
        chroma = Path(str(mem.get("chroma_db_path") or "./data/memory/chroma_db"))
        if chroma.is_absolute():
            return chroma.parent
        return Path("./data/memory")

    def _assert_safe_memory_dst(self, mem_dst: Path) -> None:
        """Refuse restore targets that would wipe backup dir or the process cwd."""
        try:
            dst = mem_dst.resolve()
        except OSError as e:
            raise ValueError(f"invalid memory root: {mem_dst}") from e
        cwd = Path.cwd().resolve()
        if dst == cwd:
            raise ValueError("refusing to replace memory root equal to cwd")
        try:
            backup_dir = self.local_dir.resolve()
        except OSError:
            backup_dir = self.local_dir
        if dst == backup_dir or backup_dir in dst.parents:
            raise ValueError("refusing to replace a path that contains backup.local_dir")
        if dst in backup_dir.parents or dst == backup_dir.parent:
            raise ValueError("refusing to replace a parent of backup.local_dir")

    def resolve_archive_path(self, archive_name: str) -> Path:
        """Validate archive name and return local zip path (download if needed)."""
        name = Path(str(archive_name or "").strip()).name
        if not name or name != archive_name.strip() or ".." in name or "/" in name or "\\" in name:
            raise ValueError("invalid archive name")
        if not name.endswith(".zip"):
            raise ValueError("archive must be a .zip file")
        src = self.local_dir / name
        if not src.exists():
            if self.external_adapter is None:
                raise FileNotFoundError(f"Backup not found: {src}")
            src = self.external_adapter.download_file(name, self.local_dir / name)
        if not src.is_file():
            raise FileNotFoundError(f"Backup not found: {src}")
        return src

    @staticmethod
    def _build_memory_staging(restore_root: Path, staging_mem: Path) -> Path | None:
        """Merge archive layout: full tree from memory/ (or legacy name) + SQLite overlay.

        ``run_backup`` always writes the memory tree as ``memory/`` and Hub DB files
        under ``data/memory/``. Older archives may use the folder basename instead.
        """
        full_tree = restore_root / "memory"
        if not full_tree.is_dir():
            # Legacy / non-standard: try parent name from manifest chroma_db_path
            manifest_path = restore_root / "backup_manifest.json"
            if manifest_path.is_file():
                try:
                    man = json.loads(manifest_path.read_text(encoding="utf-8"))
                    chroma = Path(str((man or {}).get("chroma_db_path") or ""))
                    if chroma.name:
                        alt = restore_root / chroma.parent.name
                        if alt.is_dir() and alt.name not in ("data", "logs"):
                            full_tree = alt
                except Exception:
                    pass
        db_only = restore_root / "data" / "memory"
        has_full = full_tree.is_dir()
        has_db = db_only.is_dir()
        if not has_full and not has_db:
            return None
        if staging_mem.exists():
            shutil.rmtree(staging_mem, ignore_errors=True)
        staging_mem.parent.mkdir(parents=True, exist_ok=True)
        if has_full:
            shutil.copytree(full_tree, staging_mem)
        else:
            staging_mem.mkdir(parents=True, exist_ok=True)
        if has_db:
            for p in db_only.iterdir():
                if p.is_file():
                    shutil.copy2(p, staging_mem / p.name)
                elif p.is_dir() and not has_full:
                    dest = staging_mem / p.name
                    if dest.exists():
                        shutil.rmtree(dest, ignore_errors=True)
                    shutil.copytree(p, dest)
        if not any(staging_mem.iterdir()):
            return None
        return staging_mem

    def _last_apply_path(self) -> Path:
        return self.local_dir / LAST_APPLY_NAME

    def write_last_apply_result(self, result: dict) -> None:
        """Persist last pending-restore outcome for API/UI (AR-44)."""
        self.local_dir.mkdir(parents=True, exist_ok=True)
        status = str(result.get("status") or "")
        if not status:
            status = "applied" if result.get("applied") else "failed"
        payload = {
            "status": status,
            "archive_name": result.get("archive_name") or "",
            "error": str(result.get("error") or "")[:200],
            "at": str(result.get("at") or datetime.now().isoformat(timespec="seconds")),
            "created_at": str(result.get("created_at") or ""),
            "aside_path": str(result.get("aside_path") or ""),
        }
        self._last_apply_path().write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def read_last_apply_result(self) -> dict | None:
        path = self._last_apply_path()
        if not path.is_file():
            return None
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
            return raw if isinstance(raw, dict) else None
        except Exception:
            return None

    @staticmethod
    def _unique_aside_path(dst_dir: Path) -> Path:
        """Pick a free ``*.pre-restore-<ts>`` name without deleting an existing aside."""
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        base = dst_dir.parent / f"{dst_dir.name}.pre-restore-{ts}"
        if not base.exists():
            return base
        for i in range(1, 1000):
            cand = dst_dir.parent / f"{dst_dir.name}.pre-restore-{ts}-{i}"
            if not cand.exists():
                return cand
        raise RuntimeError("could not allocate aside path for restore")

    @staticmethod
    def _swap_tree_via_rename(src_dir: Path, dst_dir: Path) -> Path | None:
        """Move dst aside, copy src into place. Returns aside path (or None if no prior dst).

        On copy failure, restores the aside folder. Caller deletes aside only after
        the full apply (including external sqlite) succeeds.
        """
        dst_dir.parent.mkdir(parents=True, exist_ok=True)
        aside: Path | None = None
        if dst_dir.exists():
            aside = BackupManager._unique_aside_path(dst_dir)
            dst_dir.rename(aside)
        try:
            shutil.copytree(src_dir, dst_dir)
        except Exception:
            if aside is not None and aside.exists():
                if dst_dir.exists():
                    shutil.rmtree(dst_dir, ignore_errors=True)
                if dst_dir.exists():
                    raise
                aside.rename(dst_dir)
            raise
        return aside

    @staticmethod
    def _rollback_aside(mem_dst: Path, aside: Path | None) -> bool:
        """Put aside live tree back. Returns True if live tree is restored."""
        if aside is None or not aside.exists():
            return True
        try:
            if mem_dst.exists():
                shutil.rmtree(mem_dst)
            if mem_dst.exists():
                return False
            aside.rename(mem_dst)
            return True
        except Exception:
            logger.exception("Failed to roll back memory aside %s", aside)
            return False

    def _place_sqlite_outside_memory(self, staged_mem: Path, mem_dst: Path) -> None:
        """If sqlite_path is outside memory root, replace DB safely (AR-46/47)."""
        mem_cfg = self.config.get("memory") if isinstance(self.config.get("memory"), dict) else {}
        db = Path(str(mem_cfg.get("sqlite_path") or (mem_dst / "neyra_memory.db")))
        try:
            db_res = db.resolve()
            mem_res = mem_dst.resolve()
            db_outside = mem_res not in db_res.parents and db_res != (mem_res / db.name)
        except OSError:
            db_outside = True
        if not db_outside:
            return
        cand = staged_mem / db.name
        if not cand.is_file():
            matches = list(staged_mem.glob("*.db"))
            cand = matches[0] if matches else cand
        if not cand.is_file():
            return
        db.parent.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        moved: list[tuple[Path, Path]] = []
        tmp_db = db.parent / f".{db.name}.restore-tmp-{ts}"
        try:
            for suffix in ("", "-wal", "-shm"):
                live = Path(str(db) + suffix) if suffix else db
                if not live.exists():
                    continue
                aside = live.parent / f"{live.name}.pre-restore-{ts}"
                n = 0
                while aside.exists():
                    n += 1
                    aside = live.parent / f"{live.name}.pre-restore-{ts}-{n}"
                live.rename(aside)
                moved.append((live, aside))
            shutil.copy2(cand, tmp_db)
            os.replace(tmp_db, db)
            for suffix in ("-wal", "-shm"):
                side_src = staged_mem / (db.name + suffix)
                if side_src.is_file():
                    shutil.copy2(side_src, Path(str(db) + suffix))
            for _live, aside in moved:
                if aside.exists():
                    try:
                        if aside.is_dir():
                            shutil.rmtree(aside, ignore_errors=True)
                        else:
                            aside.unlink()
                    except OSError:
                        pass
        except Exception:
            if tmp_db.exists():
                try:
                    tmp_db.unlink()
                except OSError:
                    pass
            if db.exists() and not any(live == db for live, _ in moved):
                try:
                    db.unlink()
                except OSError:
                    pass
            for live, aside in reversed(moved):
                if aside.exists() and not live.exists():
                    try:
                        aside.rename(live)
                    except OSError:
                        logger.exception("Could not restore sqlite aside %s → %s", aside, live)
            raise

    def prepare_restore(self, archive_name: str) -> dict:
        """Unpack + stage memory for a pending swap. Does not touch live Hub/Chroma."""
        src = self.resolve_archive_path(archive_name)
        name = src.name
        mem_dst = self._memory_root()
        self._assert_safe_memory_dst(mem_dst)

        unpack_root = Path("./.tmp_restore")
        if unpack_root.exists():
            shutil.rmtree(unpack_root, ignore_errors=True)
        unpack_root.mkdir(parents=True, exist_ok=True)
        try:
            shutil.unpack_archive(str(src), str(unpack_root), "zip")
            built = self._build_memory_staging(unpack_root, unpack_root / ".neyra_memory_staging")
            if built is None:
                raise ValueError("archive has no memory payload")

            pending = self._pending_root()
            if pending.exists():
                shutil.rmtree(pending, ignore_errors=True)
            pending.mkdir(parents=True, exist_ok=True)
            staged = pending / PENDING_MEMORY
            shutil.copytree(built, staged)
            created_at = datetime.now().isoformat(timespec="seconds")
            flag = {
                "archive_name": name,
                "archive_path": str(src),
                "memory_root": str(mem_dst),
                "created_at": created_at,
            }
            (pending / PENDING_FLAG).write_text(
                json.dumps(flag, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            return {
                "pending": True,
                "archive_name": name,
                "restored_from": str(src),
                "memory_root": str(mem_dst),
                "logs_restored": False,
                "applied": False,
                "created_at": created_at,
            }
        finally:
            shutil.rmtree(unpack_root, ignore_errors=True)

    def apply_pending_restore(self) -> dict | None:
        """Apply staged restore if a pending flag exists. Call before opening Hub/Chroma.

        On failure: roll live memory back, keep pending staging, write failed result (AR-43/47).
        """
        pending = self._pending_root()
        flag_path = pending / PENDING_FLAG
        staged = pending / PENDING_MEMORY
        if not flag_path.is_file() or not staged.is_dir():
            if pending.exists() and not flag_path.is_file():
                shutil.rmtree(pending, ignore_errors=True)
            return None
        try:
            flag = json.loads(flag_path.read_text(encoding="utf-8"))
        except Exception:
            logger.exception("pending restore flag unreadable; leaving pending in place")
            self.write_last_apply_result(
                {
                    "applied": False,
                    "status": "failed",
                    "archive_name": "",
                    "error": "pending_flag_unreadable",
                }
            )
            return {"applied": False, "pending": True, "error": "pending_flag_unreadable"}
        mem_dst = Path(str(flag.get("memory_root") or self._memory_root()))
        archive_name = flag.get("archive_name")
        created_at = str(flag.get("created_at") or "")
        aside: Path | None = None
        try:
            self._assert_safe_memory_dst(mem_dst)
            aside = self._swap_tree_via_rename(staged, mem_dst)
            self._place_sqlite_outside_memory(staged, mem_dst)
            out = {
                "applied": True,
                "status": "applied",
                "pending": False,
                "archive_name": archive_name,
                "restored_from": flag.get("archive_path"),
                "restored_paths": [str(mem_dst)],
                "memory_root": str(mem_dst),
                "logs_restored": False,
                "created_at": created_at,
                "at": datetime.now().isoformat(timespec="seconds"),
            }
            # Status write must not turn a successful swap into "failed".
            try:
                self.write_last_apply_result(out)
            except Exception:
                logger.exception("Could not write last_restore_apply.json after successful apply")
            shutil.rmtree(pending, ignore_errors=True)
            if aside is not None and aside.exists():
                shutil.rmtree(aside, ignore_errors=True)
            logger.info(
                "Applied pending restore | archive=%s memory_root=%s",
                archive_name,
                mem_dst,
            )
            return out
        except Exception as e:
            logger.exception("Pending restore apply failed | archive=%s", archive_name)
            rolled = self._rollback_aside(mem_dst, aside)
            if rolled:
                failed = {
                    "applied": False,
                    "status": "failed",
                    "pending": True,
                    "archive_name": archive_name,
                    "error": type(e).__name__,
                    "memory_root": str(mem_dst),
                    "created_at": created_at,
                    "at": datetime.now().isoformat(timespec="seconds"),
                }
            else:
                failed = {
                    "applied": False,
                    "status": "rollback_failed",
                    "pending": True,
                    "archive_name": archive_name,
                    "error": type(e).__name__,
                    "memory_root": str(mem_dst),
                    "aside_path": str(aside) if aside else "",
                    "created_at": created_at,
                    "at": datetime.now().isoformat(timespec="seconds"),
                }
            try:
                self.write_last_apply_result(failed)
            except Exception:
                logger.exception("Could not write last_restore_apply.json")
            return failed

    def restore_backup(self, archive_name: str) -> dict:
        """Prepare then apply immediately (offline tests / no open Hub).

        Production API must use ``prepare_restore`` + soft-restart so
        ``apply_pending_restore`` runs before Memory Hub opens.
        """
        prepared = self.prepare_restore(archive_name)
        applied = self.apply_pending_restore()
        if applied is None:
            raise RuntimeError("pending restore missing after prepare")
        return {**prepared, **applied}
