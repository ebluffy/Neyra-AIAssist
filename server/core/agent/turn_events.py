"""Event Bus publishers for completed / failed chat turns."""

from __future__ import annotations

from typing import Any, Optional

from core.runtime.event_bus import (
    CHAT_TURN_COMPLETED,
    CHAT_TURN_FAILED,
    MEMORY_LONG_TERM_WRITE,
    MEMORY_SHORT_TERM_UPDATE,
    CoreEvent,
)


def publish_memory_and_chat_events(
    event_bus: Any,
    *,
    internal_user_id: str,
    channel_id: Optional[str],
    username: Optional[str],
    user_message: str,
    clean_text: str,
    sounds: list,
    metadata: dict,
    short_memory_len: int,
    rag_enabled: bool,
) -> None:
    event_bus.publish(
        CoreEvent(
            MEMORY_SHORT_TERM_UPDATE,
            "core.agent",
            {
                "user_id": internal_user_id,
                "channel_id": channel_id,
                "short_memory_messages": short_memory_len,
            },
        )
    )
    event_bus.publish(
        CoreEvent(
            MEMORY_LONG_TERM_WRITE,
            "core.agent",
            {
                "user_id": internal_user_id,
                "username": metadata.get("username"),
                "discord_id": metadata.get("discord_id"),
                "rag_enabled": rag_enabled,
            },
        )
    )
    event_bus.publish(
        CoreEvent(
            CHAT_TURN_COMPLETED,
            "core.agent",
            {
                "user_id": internal_user_id,
                "channel_id": channel_id,
                "username": username,
                "user_chars": len(user_message or ""),
                "assistant_chars": len(clean_text or ""),
                "sounds": list(sounds) if sounds else [],
            },
        )
    )


def publish_chat_turn_failed(
    event_bus: Any,
    *,
    internal_user_id: str,
    channel_id: Optional[str],
    error: str,
) -> None:
    event_bus.publish(
        CoreEvent(
            CHAT_TURN_FAILED,
            "core.agent",
            {
                "user_id": internal_user_id,
                "channel_id": channel_id,
                "error": error[:2000],
            },
        )
    )
