"""SQLite chat_log dual-write helpers (Memory Hub)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional

logger = logging.getLogger("neyra.agent.chat_log")


async def append_turn_to_chat_log(
    memory_hub: Any,
    *,
    user_text: str,
    assistant_text: str,
    internal_user_id: str,
    display_name: Optional[str],
    channel_id: Optional[str],
    source: Optional[str],
    assistant_name: Optional[str] = None,
    meta: Optional[dict] = None,
    latency_ms: Optional[float] = None,
) -> str:
    """Append user+assistant rows for one turn. Returns turn_id or \"\" on failure."""
    turn_id = memory_hub.new_turn_id()
    base_meta = dict(meta or {})
    rows = [
        {
            "role": "user",
            "text": user_text,
            "user_id": internal_user_id,
            "display_name": display_name,
            "channel_id": channel_id,
            "source": source or "agent",
            "turn_id": turn_id,
            "meta": base_meta,
        },
        {
            "role": "assistant",
            "text": assistant_text,
            "user_id": internal_user_id,
            "display_name": assistant_name,
            "channel_id": channel_id,
            "source": source or "agent",
            "turn_id": turn_id,
            "latency_ms": latency_ms,
            "meta": base_meta,
        },
    ]
    try:
        # Offload blocking SQLite IMMEDIATE txn off the event loop (ADR-0001).
        await asyncio.to_thread(memory_hub.append_chat_batch, rows)
    except Exception as e:
        logger.exception("MemoryHub chat_log append failed: %s", e)
        return ""
    return turn_id
