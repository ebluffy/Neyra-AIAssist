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

    def restore_backup(self, archive_name: str) -> dict:
        src = self.local_dir / archive_name
        if not src.exists():
            if self.external_adapter is None:
                raise FileNotFoundError(f"Backup not found: {src}")
            src = self.external_adapter.download_file(archive_name, self.local_dir / archive_name)
        restore_root = Path("./.tmp_restore")
        if restore_root.exists():
            shutil.rmtree(restore_root, ignore_errors=True)
        restore_root.mkdir(parents=True, exist_ok=True)
        shutil.unpack_archive(str(src), str(restore_root), "zip")
        for name in ("memory", "logs"):
            src_dir = restore_root / name
            if src_dir.exists():
                dst_dir = Path(f"./{name}")
                dst_dir.mkdir(parents=True, exist_ok=True)
                shutil.copytree(src_dir, dst_dir, dirs_exist_ok=True)
        shutil.rmtree(restore_root, ignore_errors=True)
        return {"restored_from": str(src)}
