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

    def _logs_root(self) -> Path:
        return Path("./logs")

    @staticmethod
    def _replace_tree(src_dir: Path, dst_dir: Path) -> None:
        """Replace destination directory contents (no merge of stale files)."""
        if dst_dir.exists():
            shutil.rmtree(dst_dir, ignore_errors=True)
        dst_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(src_dir, dst_dir)

    def _clear_sqlite_sidecars(self) -> None:
        """Drop live Hub wal/shm so a restored .db is not paired with stale WAL."""
        for p in self._sqlite_paths():
            name = p.name
            if name.endswith("-wal") or name.endswith("-shm"):
                try:
                    if p.is_file():
                        p.unlink()
                except OSError as e:
                    logger.warning("Could not remove sqlite sidecar %s: %s", p, e)

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
        shutil.unpack_archive(str(src), str(restore_root), "zip")
        mem_dst = self._memory_root()
        logs_dst = self._logs_root()
        mem_src = restore_root / "data" / "memory"
        if not mem_src.exists():
            mem_src = restore_root / "memory"
        logs_src = restore_root / "logs"
        # Clear WAL/SHM before replacing memory tree so Hub does not reopen stale sidecars.
        self._clear_sqlite_sidecars()
        restored: list[str] = []
        if mem_src.exists():
            self._replace_tree(mem_src, mem_dst)
            restored.append(str(mem_dst))
            # If sqlite_path lives outside memory root, place DB files from the archive there.
            mem_cfg = self.config.get("memory") if isinstance(self.config.get("memory"), dict) else {}
            db = Path(str(mem_cfg.get("sqlite_path") or (mem_dst / "neyra_memory.db")))
            try:
                db_outside = mem_dst.resolve() not in db.resolve().parents and db.resolve() != (mem_dst / db.name).resolve()
            except OSError:
                db_outside = True
            if db_outside:
                for suffix in ("", "-wal", "-shm"):
                    leaf = db.name + suffix
                    cand = mem_src / leaf
                    if not cand.is_file() and suffix == "":
                        matches = list(mem_src.glob("*.db"))
                        cand = matches[0] if matches else cand
                    if cand.is_file():
                        target = Path(str(db) + suffix) if suffix else db
                        target.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(cand, target)
        if logs_src.exists():
            self._replace_tree(logs_src, logs_dst)
            restored.append(str(logs_dst))
        shutil.rmtree(restore_root, ignore_errors=True)
        return {
            "restored_from": str(src),
            "archive_name": name,
            "restored_paths": restored,
            "memory_root": str(mem_dst),
        }
