"""Agent bootstrap: memory, tools, MCP, log paths."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger("neyra.agent.bootstrap")


def setup_memory(agent: Any) -> None:
    """Wire STM / LTM / PeopleDB / diary / MemoryHub and seed people if empty."""
    from core.memory import LongTermMemory, MemoryHub, NeyraDiary, PeopleDB, ShortTermMemory

    mem_cfg = agent.config.get("memory", {}) or {}
    stm_max = int(mem_cfg.get("stm_max_messages") or 10)
    agent.short_memory = ShortTermMemory(max_messages=max(2, stm_max))
    agent.long_memory = LongTermMemory(agent.config)
    agent.people_db = PeopleDB(agent.config)
    agent.diary = NeyraDiary(agent.config)
    agent.memory_hub = MemoryHub(
        agent.config,
        long_memory=agent.long_memory,
        event_bus=agent.event_bus,
    )
    agent.people_db.memory_hub = agent.memory_hub
    agent.diary.memory_hub = agent.memory_hub
    try:
        agent.people_db.hydrate_from_hub(agent.memory_hub)
    except Exception as e:
        logger.warning("PeopleDB hydrate_from_hub failed: %s", e)

    if bool(mem_cfg.get("rag_init_in_background", True)):
        logger.info("Инициализирую долгосрочную память в фоне...")
        agent.long_memory.initialize_async()
    else:
        logger.info("Инициализирую долгосрочную память...")
        agent.long_memory.initialize()

    agent._init_people_db()


def setup_tools(agent: Any) -> None:
    """Register builtin tools and optional MCP manager (not started yet)."""
    from core.tools import ALL_TOOLS, init_tools

    init_tools(
        agent.long_memory,
        agent.people_db,
        agent.config.get("assistant") or {},
        neyra_config=agent.config,
        memory_hub=agent.memory_hub,
    )
    agent.tools = {t.name: t for t in ALL_TOOLS}
    agent.mcp_manager = None
    agent._mcp_merge_done = False
    mc = agent.config.get("mcp_client") if isinstance(agent.config.get("mcp_client"), dict) else {}
    if mc.get("enabled"):
        from core.runtime.mcp_client import MCPClientManager

        agent.mcp_manager = MCPClientManager(agent.config)
    logger.info("Tools готовы: %s", list(agent.tools.keys()))


async def ensure_mcp(agent: Any) -> None:
    """Start MCP clients once and merge dynamic tools into ``agent.tools``."""
    if agent._mcp_merge_done or not agent.mcp_manager:
        return
    try:
        await agent.mcp_manager.start()
    except Exception as e:
        logger.exception("MCP: не удалось запустить клиенты: %s", e)
    try:
        for t in agent.mcp_manager.get_langchain_tools():
            agent.tools[t.name] = t
    except Exception as e:
        logger.warning("MCP: список инструментов недоступен: %s", e)
    agent._mcp_merge_done = True
    logger.info("MCP: после merge доступно tools=%s", len(agent.tools))


async def stop_mcp(agent: Any) -> None:
    if not agent.mcp_manager:
        return
    try:
        await agent.mcp_manager.stop()
    except Exception as e:
        logger.debug("MCP stop: %s", e)
    agent._mcp_merge_done = False


def setup_logs(agent: Any) -> None:
    """Ensure thoughts / chat log directories exist."""
    mem_cfg = agent.config.get("memory", {})
    log_cfg = agent.config.get("logging", {})

    agent.thoughts_log_path = Path(mem_cfg.get("thoughts_log", "./data/memory/thoughts.log"))
    agent.chat_log_path = Path(log_cfg.get("chat_log", "./logs/chat.log"))

    agent.thoughts_log_path.parent.mkdir(parents=True, exist_ok=True)
    agent.chat_log_path.parent.mkdir(parents=True, exist_ok=True)
