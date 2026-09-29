"""
RU: Точка входа плагина 000EXAMPLE. Обязателен экспорт run_plugin(ctx) — см. HELP.md / HELP-RU.md.
EN: Entry point for 000EXAMPLE plugin. Must export run_plugin(ctx) — see HELP.md / HELP-RU.md.
"""

from __future__ import annotations

import logging
from typing import Any

from core.plugins.sdk import PluginContext

logger = logging.getLogger("neyra.plugin.example")


def run_plugin(ctx: PluginContext) -> None:
    # RU: Синхронная функция; блокирующий код допустим (как discord.run / uvicorn.run).
    # EN: Synchronous entry; blocking calls OK (e.g. discord.run / uvicorn.run).
    logger.info(
        "000EXAMPLE run_plugin | root=%s | agent=%s",
        ctx.root,
        "yes" if ctx.agent is not None else "no",
    )
    # RU: Учебный пример — без сети и секретов. Реальные интерфейсы: discord, internal_api.
    # EN: Tutorial only — no network/secrets. Real interfaces: discord, internal_api.
    print(
        "[000EXAMPLE] OK. See modules/discord/ or modules/internal_api/ for real plugins."
    )


# RU: Ниже — необязательные заготовки под будущий SDK (события, горячая перезагрузка).
# EN: Optional stubs for a future SDK (events, hot reload).
def setup(context: dict[str, Any] | None = None) -> None:
    logger.info("Example plugin setup | context_keys=%s", list((context or {}).keys()))


def handle_event(event: Any) -> None:
    logger.debug("Example plugin got event: %s", event)


def shutdown() -> None:
    logger.info("Example plugin shutdown")
