"""SQLite chat_log dual-write helpers (Memory Hub)."""

from __future__ import annotations

import asyncio
import logging
from contextvars import ContextVar
from typing import Any, Optional

# Only the bridge chat task sets this; scoped metadata, not model input.
DESKTOP_CHAT_REQUEST: ContextVar[tuple[str, str] | None] = ContextVar("desktop_chat_request", default=None)

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
    origin: Optional[dict] = None,
) -> str:
    """Append user+assistant rows for one turn. Returns turn_id or \"\" on failure."""
    from core.agent.model_trace import ACTIVE_TRACE
    trace = ACTIVE_TRACE.get()
    turn_id = trace.id if trace is not None and not trace.closed else memory_hub.new_turn_id()
    base_meta = dict(meta or {})
    # Where the turn happened: Discord guild/message ids or the web channel prefix.
    origin_data = dict(origin or {})
    platform = str(origin_data.get("platform") or "").strip() or None
    if platform is None and str(channel_id or "").startswith("web:"):
        platform = "web"
    guild_id = str(origin_data.get("guild_id") or "").strip() or None
    native_message_id = str(origin_data.get("native_message_id") or "").strip() or None
    native_created_at = str(origin_data.get("native_created_at") or "").strip() or None
    desktop_request = DESKTOP_CHAT_REQUEST.get()
    if desktop_request is not None and desktop_request[1] == channel_id:
        base_meta["desktop_request_id"] = desktop_request[0]
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
            "platform": platform,
            "guild_id": guild_id,
            "native_message_id": native_message_id,
            "native_created_at": native_created_at,
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
            "platform": platform,
            "guild_id": guild_id,
            "native_message_id": native_message_id,
            "native_created_at": native_created_at,
        },
    ]
    try:
        # Offload blocking SQLite IMMEDIATE txn off the event loop (ADR-0001).
        await asyncio.to_thread(memory_hub.append_chat_batch, rows)
    except Exception as e:
        logger.exception("MemoryHub chat_log append failed: %s", e)
        return ""
    return turn_id


def origin_from_discord_context(context: Any) -> dict[str, Any]:
    """Origin fields for chat_log from a DiscordContext (empty for web/other turns)."""
    if context is None:
        return {}
    guild = getattr(context, "guild", None)
    message = getattr(context, "message", None)
    return {
        "platform": "discord",
        "guild_id": str(getattr(guild, "id", "") or "").strip() or None,
        "native_message_id": str(getattr(message, "id", "") or "").strip() or None,
        "native_created_at": getattr(message, "created_at", None),
    }
