"""
Minimal plugin loader for modules/* plugin.yaml manifests.
"""

from __future__ import annotations

import importlib.util
import logging
import shutil
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any

import yaml

logger = logging.getLogger("neyra.plugins")


@dataclass
class PluginManifest:
    id: str
    name: str
    description: str
    version: str
    enabled: bool
    # resident: load main_script at startup; on_demand: registry only until invoke
    lifecycle: str
    # Опционально: зарезервированные имена для invoke API / совместимости (основной процесс: core|console).
    cli_modes: list[str]
    main_script: str
    plugin_dir: Path
    raw: dict[str, Any]


class PluginLoader:
    """Discover, inspect and load plugin modules from `modules/*`.

    Args:
        root: Repository root path.
    """

    def __init__(self, root: Path):
        self.root = Path(root)
        self.modules_dir = self.root / "modules"
        self._backups_dir = self.root / "data" / "memory" / "plugin_backups"

    def discover_manifests(self) -> list[PluginManifest]:
        out: list[PluginManifest] = []
        if not self.modules_dir.exists():
            return out
        for manifest_path in self.modules_dir.glob("*/plugin.yaml"):
            try:
                raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
                if not isinstance(raw, dict):
                    continue
                plugin_dir = manifest_path.parent
                lc = str(raw.get("lifecycle") or "resident").strip().lower()
                if lc not in ("resident", "on_demand"):
                    lc = "resident"
                raw_modes = raw.get("cli_modes") or raw.get("modes") or []
                if isinstance(raw_modes, str):
                    raw_modes = [raw_modes]
                cli_modes = [str(x).strip().lower() for x in raw_modes if str(x).strip()]
                out.append(
                    PluginManifest(
                        id=str(raw.get("id") or plugin_dir.name).strip(),
                        name=str(raw.get("name") or plugin_dir.name).strip(),
                        description=str(raw.get("description") or "").strip(),
                        version=str(raw.get("version") or "0.0.0").strip(),
                        enabled=bool(raw.get("enabled", True)),
                        lifecycle=lc,
                        cli_modes=cli_modes,
                        main_script=str(raw.get("main_script") or "").strip(),
                        plugin_dir=plugin_dir,
                        raw=raw,
                    )
                )
            except Exception as e:
                logger.warning("Bad plugin manifest %s: %s", manifest_path, e)
        return out

    def list_plugins(self) -> list[dict[str, Any]]:
        rows = []
        for p in self.discover_manifests():
            rows.append(
                {
                    "id": p.id,
                    "name": p.name,
                    "description": p.description,
                    "version": p.version,
                    "enabled": p.enabled,
                    "lifecycle": p.lifecycle,
                    "cli_modes": p.cli_modes,
                    "main_script": p.main_script,
                    "plugin_dir": str(p.plugin_dir),
                }
            )
        return rows

    def cli_mode_index(self) -> dict[str, PluginManifest]:
        """mode -> manifest (последний выигрывает при дубликатах, с предупреждением в лог)."""
        idx: dict[str, PluginManifest] = {}
        for p in self.discover_manifests():
            for m in p.cli_modes:
                if m in idx and idx[m].id != p.id:
                    logger.warning(
                        "Duplicate cli_mode %r: plugin %s overrides %s",
                        m,
                        p.id,
                        idx[m].id,
                    )
                idx[m] = p
        return idx

    def manifest_for_cli_mode(self, mode: str) -> PluginManifest | None:
        mode = (mode or "").strip().lower()
        if not mode:
            return None
        return self.cli_mode_index().get(mode)

    def import_plugin_module(self, manifest: PluginManifest) -> ModuleType:
        """Загрузить main_script плагина (для CLI или invoke), независимо от lifecycle."""
        if not manifest.main_script:
            raise ValueError(f"Plugin {manifest.id} has empty main_script")
        target = (manifest.plugin_dir / manifest.main_script).resolve()
        if not target.exists():
            raise FileNotFoundError(f"Plugin {manifest.id} main script not found: {target}")
        mod_name = f"neyra_plugin_{manifest.id.replace('-', '_')}"
        spec = importlib.util.spec_from_file_location(mod_name, target)
        if spec is None or spec.loader is None:
            raise RuntimeError(f"Plugin {manifest.id} spec load failed")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def _normalize_plugin_id(self, plugin_id: str) -> str:
        return (plugin_id or "").strip().lower()

    def _find_manifest(self, plugin_id: str) -> PluginManifest | None:
        pid = self._normalize_plugin_id(plugin_id)
        if not pid:
            return None
        for m in self.discover_manifests():
            if m.id.strip().lower() == pid:
                return m
        return None

    def _module_name_for_plugin(self, plugin_id: str) -> str:
        pid = self._normalize_plugin_id(plugin_id)
        return f"neyra_plugin_{pid.replace('-', '_')}"

    def _backup_root_for_plugin(self, plugin_id: str) -> Path:
        pid = self._normalize_plugin_id(plugin_id)
        return (self._backups_dir / pid).resolve()

    def create_plugin_backup(self, plugin_id: str) -> tuple[bool, str]:
        """Сделать файловый бэкап modules/<plugin_id> в memory/plugin_backups/<plugin_id>/<ts>."""
        manifest = self._find_manifest(plugin_id)
        if manifest is None:
            return False, f"Plugin not found: {plugin_id}"

        src = manifest.plugin_dir.resolve()
        ts = time.strftime("%Y%m%d-%H%M%S")
        dst_root = self._backup_root_for_plugin(plugin_id)
        dst = (dst_root / ts).resolve()
        try:
            dst.parent.mkdir(parents=True, exist_ok=True)
            if dst.exists():
                shutil.rmtree(dst, ignore_errors=True)
            shutil.copytree(src, dst)
            return True, str(dst)
        except Exception as e:
            return False, f"Backup failed: {e}"

    def rollback_plugin(self, plugin_id: str, backup_path: str | None = None) -> tuple[bool, str]:
        """Откатить modules/<plugin_id> из бэкапа (последнего или явно указанного)."""
        manifest = self._find_manifest(plugin_id)
        if manifest is None:
            return False, f"Plugin not found: {plugin_id}"

        src_dir = manifest.plugin_dir.resolve()
        chosen: Path | None = None
        try:
            if backup_path:
                chosen = Path(backup_path).resolve()
            else:
                root = self._backup_root_for_plugin(plugin_id)
                if not root.exists():
                    return False, "No backups found"
                candidates = [p for p in root.iterdir() if p.is_dir()]
                if not candidates:
                    return False, "No backups found"
                chosen = sorted(candidates, key=lambda p: p.name)[-1]

            if chosen is None or not chosen.is_dir():
                return False, "Backup path is invalid"

            # Recreate target directory from backup.
            if src_dir.exists():
                shutil.rmtree(src_dir, ignore_errors=True)
            shutil.copytree(chosen, src_dir)
            return True, f"Rolled back from {chosen}"
        except Exception as e:
            return False, f"Rollback failed: {e}"

    def reload_plugin(self, plugin_id: str) -> tuple[bool, str]:
        """Перезагрузить модуль плагина «на горячую» (re-import main_script).

        Примечание: это перезагружает Python-модуль для будущих вызовов (CLI/invoke/internal_api).
        Для resident-плагинов, которые уже запущены в отдельном потоке, требуется отдельный lifecycle stop/start.
        """
        manifest = self._find_manifest(plugin_id)
        if manifest is None:
            return False, f"Plugin not found: {plugin_id}"

        mod_name = self._module_name_for_plugin(plugin_id)
        try:
            # Drop cached module.
            if mod_name in sys.modules:
                del sys.modules[mod_name]
            # Invalidate caches so file changes are visible.
            try:
                import importlib

                importlib.invalidate_caches()
            except Exception:
                pass

            _ = self.import_plugin_module(manifest)
            return True, "Reloaded"
        except Exception as e:
            return False, f"Reload failed: {e}"

    def set_enabled(self, plugin_id: str, enabled: bool) -> bool:
        plugin_id = (plugin_id or "").strip().lower()
        if not plugin_id:
            return False
        for manifest_path in self.modules_dir.glob("*/plugin.yaml"):
            raw = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
            if not isinstance(raw, dict):
                continue
            pid = str(raw.get("id") or manifest_path.parent.name).strip().lower()
            if pid != plugin_id:
                continue
            raw["enabled"] = bool(enabled)
            manifest_path.write_text(
                yaml.safe_dump(raw, allow_unicode=True, sort_keys=False),
                encoding="utf-8",
            )
            return True
        return False

    def load_enabled_modules(self) -> list[tuple[PluginManifest, ModuleType]]:
        loaded: list[tuple[PluginManifest, ModuleType]] = []
        for p in self.discover_manifests():
            if not p.enabled:
                logger.info("Plugin disabled, skip: %s", p.id)
                continue
            if p.lifecycle == "on_demand":
                logger.info("Plugin on_demand, registry only at startup: %s", p.id)
                continue
            try:
                module = self.import_plugin_module(p)
            except Exception as e:
                logger.warning("Plugin %s load failed: %s", p.id, e)
                continue
            loaded.append((p, module))
            logger.info("Plugin loaded: %s (%s)", p.id, p.version)
        return loaded
