"""
External storage adapters (Google Drive and local-folder fallback).
"""

from __future__ import annotations

import logging
import shutil
from abc import ABC, abstractmethod
from pathlib import Path

logger = logging.getLogger("neyra.external_storage")


class ExternalStorageAdapter(ABC):
    @abstractmethod
    def upload_file(self, local_path: Path, remote_name: str) -> str:
        raise NotImplementedError

    @abstractmethod
    def download_file(self, remote_name: str, local_path: Path) -> Path:
        raise NotImplementedError


class LocalFolderStorageAdapter(ExternalStorageAdapter):
    """Simple adapter for local folder (dev/test or pseudo-remote)."""

    def __init__(self, target_dir: Path):
        self.target_dir = Path(target_dir)
        self.target_dir.mkdir(parents=True, exist_ok=True)

    def upload_file(self, local_path: Path, remote_name: str) -> str:
        src = Path(local_path)
        dst = self.target_dir / remote_name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        return str(dst)

    def download_file(self, remote_name: str, local_path: Path) -> Path:
        src = self.target_dir / remote_name
        if not src.exists():
            raise FileNotFoundError(f"Remote file not found: {remote_name}")
        dst = Path(local_path)
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        return dst


class GoogleDriveStorageAdapter(ExternalStorageAdapter):
    """
    Google Drive adapter via pydrive2.
    Requires service-account credentials json.
    """

    def __init__(self, credentials_path: Path, folder_id: str):
        self.credentials_path = Path(credentials_path)
        self.folder_id = str(folder_id or "").strip()
        if not self.folder_id:
            raise ValueError("google_drive.folder_id is required")
        if not self.credentials_path.exists():
            raise FileNotFoundError(f"Google credentials not found: {self.credentials_path}")
        try:
            from pydrive2.auth import GoogleAuth
            from pydrive2.drive import GoogleDrive
        except Exception as e:
            raise RuntimeError("pydrive2 is required for Google Drive adapter") from e

        gauth = GoogleAuth()
        gauth.settings = {
            "client_config_backend": "service",
            "service_config": {
                "client_json_file_path": str(self.credentials_path),
            },
            "save_credentials": False,
        }
        gauth.ServiceAuth()
        self.drive = GoogleDrive(gauth)

    def upload_file(self, local_path: Path, remote_name: str) -> str:
        f = self.drive.CreateFile({"title": remote_name, "parents": [{"id": self.folder_id}]})
        f.SetContentFile(str(local_path))
        f.Upload()
        return str(f.get("id", ""))

    def download_file(self, remote_name: str, local_path: Path) -> Path:
        q = f"title='{remote_name}' and '{self.folder_id}' in parents and trashed=false"
        files = self.drive.ListFile({"q": q}).GetList()
        if not files:
            raise FileNotFoundError(f"Google Drive file not found: {remote_name}")
        dst = Path(local_path)
        dst.parent.mkdir(parents=True, exist_ok=True)
        files[0].GetContentFile(str(dst))
        return dst


def build_external_storage_adapter(config: dict) -> ExternalStorageAdapter | None:
    cfg = config.get("external_storage") or {}
    if not bool(cfg.get("enabled", False)):
        return None
    provider = str(cfg.get("provider") or "local_folder").strip().lower()
    if provider == "google_drive":
        gc = cfg.get("google_drive") or {}
        return GoogleDriveStorageAdapter(
            credentials_path=Path(str(gc.get("credentials_json") or "")),
            folder_id=str(gc.get("folder_id") or ""),
        )
    # default: local folder adapter
    local = cfg.get("local_folder") or {}
    target = Path(str(local.get("path") or "./external_storage"))
    return LocalFolderStorageAdapter(target)
