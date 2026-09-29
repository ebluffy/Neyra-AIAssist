"""
Plugin manager surface for Neyra modules/* plugins.

Canonical imports: ``from core.plugins.loader import PluginLoader``, etc.
Builder (HTTP / OpenRouter) is exported lazily so config/loader/sdk shims stay light.
"""

from __future__ import annotations

from typing import Any

from core.plugins.config import merge_plugin_configs
from core.plugins.loader import PluginLoader, PluginManifest
from core.plugins.sdk import PluginContext, run_plugin_entrypoint

__all__ = [
    "PluginBuilderSettings",
    "PluginContext",
    "PluginLoader",
    "PluginManifest",
    "create_or_edit_plugin_impl",
    "merge_plugin_configs",
    "run_plugin_entrypoint",
]

_BUILDER_NAMES = frozenset({"PluginBuilderSettings", "create_or_edit_plugin_impl"})


def __getattr__(name: str) -> Any:
    if name in _BUILDER_NAMES:
        from core.plugins import builder as mod

        return getattr(mod, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
