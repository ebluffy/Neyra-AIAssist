"""Подмешивание настроек из modules/<plugin_id>/config.yaml в общий dict конфига."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger("neyra.plugin_config")


def merge_plugin_configs(config: dict[str, Any], root: Path) -> None:
    """
    Для каждого modules/<id>/config.yaml:
    - discord → ключ `discord` (поверх корневого config.yaml)
    - остальные id → config.plugins[id]

    Core API (`api:` / `dashboard:`) lives in config/server.yaml — not a module.
    """
    if not isinstance(config, dict):
        return
    modules = root / "modules"
    if not modules.is_dir():
        return
    for plugin_dir in sorted(modules.iterdir()):
        if not plugin_dir.is_dir():
            continue
        cfg_file = plugin_dir / "config.yaml"
        if not cfg_file.is_file():
            continue
        try:
            raw = yaml.safe_load(cfg_file.read_text(encoding="utf-8"))
        except Exception as e:
            logger.warning("Skip plugin config %s: %s", cfg_file, e)
            continue
        if not isinstance(raw, dict):
            logger.warning("Skip plugin config %s: root must be a mapping", cfg_file)
            continue
        pid = plugin_dir.name
        if pid == "discord":
            prev = config.get("discord")
            prev_d: dict[str, Any] = prev if isinstance(prev, dict) else {}
            config["discord"] = {**prev_d, **raw}
        else:
            plugs = config.get("plugins")
            if not isinstance(plugs, dict):
                plugs = {}
            prev = plugs.get(pid)
            prev_d = prev if isinstance(prev, dict) else {}
            plugs[pid] = {**prev_d, **raw}
            config["plugins"] = plugs
