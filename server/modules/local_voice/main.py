"""Точка входа плагина local_voice."""

from __future__ import annotations

from core.plugins.sdk import PluginContext


def run_plugin(ctx: PluginContext) -> None:
    from modules.local_voice.stub import run_local_voice_agent

    run_local_voice_agent(ctx.config)
