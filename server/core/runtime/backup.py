"""
Backup/restore manager with external storage sync.
"""

from __future__ import annotations

import json
import logging
import shutil
from datetime import datetime
from pathlib import Path

from core.runtime.external_storage import ExternalStorageAdapter, build_external_storage_adapter

logger = logging.getLogger("neyra.backup")


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
        for p in self.sources:
            if p.exists():
                dst = tmp_root / p.name
                if p.is_dir():
                    shutil.copytree(p, dst, dirs_exist_ok=True)
                else:
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
            # mem_dst is an ancestor of backups — wiping it would delete archives
            raise ValueError("refusing to replace a parent of backup.local_dir")

    @staticmethod
    def _build_memory_staging(restore_root: Path, staging_mem: Path) -> Path | None:
        """Merge archive layout: full tree from memory/ plus SQLite overlay from data/memory/.

        run_backup stores chroma under ``memory/`` (source folder name) and only
        Hub DB files under ``data/memory/``. Prefer the full tree, then overlay DB.
        """
        full_tree = restore_root / "memory"
        db_only = restore_root / "data" / "memory"
        # Legacy / hand-built archives may put chroma inside data/memory/
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
                    # Hand-built archive: chroma under data/memory/
                    dest = staging_mem / p.name
                    if dest.exists():
                        shutil.rmtree(dest, ignore_errors=True)
                    shutil.copytree(p, dest)
        # Staging must contain something useful
        if not any(staging_mem.iterdir()):
            return None
        return staging_mem

    @staticmethod
    def _replace_tree(src_dir: Path, dst_dir: Path) -> None:
        """Replace destination directory contents (no merge of stale files)."""
        if dst_dir.exists():
            shutil.rmtree(dst_dir)
        dst_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src_dir, dst_dir)

    def _place_sqlite_outside_memory(self, staged_mem: Path, mem_dst: Path) -> None:
        """If sqlite_path is outside memory root, copy DB files there after tree swap."""
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
        for suffix in ("", "-wal", "-shm"):
            leaf = db.name + suffix
            cand = staged_mem / leaf
            if not cand.is_file() and suffix == "":
                matches = list(staged_mem.glob("*.db"))
                cand = matches[0] if matches else cand
            if cand.is_file():
                target = Path(str(db) + suffix) if suffix else db
                target.parent.mkdir(parents=True, exist_ok=True)
                # Drop live sidecars only when we have a replacement file ready.
                if target.is_file():
                    try:
                        target.unlink()
                    except OSError as e:
                        logger.warning("Could not remove old sqlite file %s: %s", target, e)
                shutil.copy2(cand, target)

    def restore_backup(self, archive_name: str) -> dict:
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
        restore_root = Path("./.tmp_restore")
        if restore_root.exists():
            shutil.rmtree(restore_root, ignore_errors=True)
        restore_root.mkdir(parents=True, exist_ok=True)
        try:
            shutil.unpack_archive(str(src), str(restore_root), "zip")
            mem_dst = self._memory_root()
            self._assert_safe_memory_dst(mem_dst)
            staging_mem = restore_root / ".neyra_memory_staging"
            built = self._build_memory_staging(restore_root, staging_mem)
            restored: list[str] = []
            if built is None:
                raise ValueError("archive has no memory payload")
            # Swap only after staging is ready. Do not touch logs/ (audit trail stays).
            # WAL/SHM under memory root go away with rmtree; do not delete them earlier.
            self._replace_tree(built, mem_dst)
            restored.append(str(mem_dst))
            self._place_sqlite_outside_memory(built, mem_dst)
            return {
                "restored_from": str(src),
                "archive_name": name,
                "restored_paths": restored,
                "memory_root": str(mem_dst),
                "logs_restored": False,
            }
        finally:
            shutil.rmtree(restore_root, ignore_errors=True)
