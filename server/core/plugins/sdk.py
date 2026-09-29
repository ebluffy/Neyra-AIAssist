"""
Plugin SDK: контекст выполнения и входная точка плагина.

Каждый плагин в modules/<id>/ с plugin.yaml должен экспортировать:

    def run_plugin(ctx: PluginContext) -> None:

Синхронная блокирующая функция (например discord.py bot.run, uvicorn.run).
"""

from __future__ import annotations

import inspect
import logging
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any, Optional

logger = logging.getLogger("neyra.plugins")


@dataclass
class PluginContext:
    """Контекст запуска плагина из main.py."""

    root: Path
    config: dict
    """NeyraAgent для интерфейсов, которым нужен агент (Discord); иначе None."""
    agent: Any = None


def run_plugin_entrypoint(module: ModuleType, ctx: PluginContext) -> None:
    """Вызывает run_plugin(ctx) из загруженного модуля плагина."""
    fn = getattr(module, "run_plugin", None)
    if not callable(fn):
        raise RuntimeError(f"Plugin module {module.__name__} has no run_plugin(ctx)")
    sig = inspect.signature(fn)
    if len(sig.parameters) != 1:
        raise RuntimeError("run_plugin must accept exactly (ctx: PluginContext)")
    fn(ctx)
