"""Точка входа плагина internal_api."""

from __future__ import annotations

from core.plugins.sdk import PluginContext


def run_plugin(ctx: PluginContext) -> None:
    from modules.internal_api.api_server import run_internal_api

    run_internal_api(ctx.config)
