"""Точка входа объединённого плагина discord (текст + музыка)."""

from __future__ import annotations

from core.plugins.sdk import PluginContext


def run_plugin(ctx: PluginContext) -> None:
    from modules.discord import music
    from modules.discord.bot import run_discord_bot

    if ctx.agent is None:
        raise RuntimeError("discord requires PluginContext.agent")
    music.bootstrap_resident(ctx)
    run_discord_bot(ctx.agent, ctx.config)
