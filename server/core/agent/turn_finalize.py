"""Persist turn side-effects after a successful reply (STM / Hub / jobs / events)."""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger("neyra.agent.turn_finalize")


async def finalize_successful_turn(
    agent: Any,
    *,
    user_message: str,
    clean_text: str,
    thoughts: str,
    sounds: list,
    username: Optional[str],
    discord_user_id: Optional[str],
    channel_id: Optional[str],
    speaker_label: str,
    internal_uid: str,
    vision_images: Optional[list],
    saved_facts: list[str],
    source: str = "chat",
    stm_trimmed: bool = False,
    extra_meta: Optional[dict] = None,
) -> dict:
    """Update STM, Hub chat_log, LTM, diaries/jobs, and Event Bus. Returns metadata dict."""
    spoken_user = agent._format_spoken_user_message(user_message, speaker_label)
    agent.short_memory.add("user", spoken_user)
    agent.short_memory.add("assistant", clean_text)

    metadata = {
        "username": username or "unknown",
        "discord_id": discord_user_id or "",
        "user_id": internal_uid,
    }
    if isinstance(extra_meta, dict) and extra_meta:
        metadata.update(extra_meta)
    await agent._append_turn_to_chat_log(
        user_text=spoken_user,
        assistant_text=clean_text,
        internal_user_id=internal_uid,
        display_name=username or speaker_label,
        channel_id=channel_id,
        source=source,
        meta=metadata,
    )
    await agent._save_dialog_to_ltm_with_emotion(
        user_message, clean_text, metadata, speaker_label
    )

    agent._log_thought(thoughts, user_message)
    agent._log_chat(user_message, clean_text, metadata)
    agent._store_vision_note_if_needed(channel_id, vision_images, thoughts, clean_text)
    agent._schedule_async_reflection(
        user_message=user_message,
        assistant_text=clean_text,
        username=username,
        discord_user_id=discord_user_id,
    )
    agent._schedule_working_memory_refresh(
        internal_user_id=internal_uid,
        user_message=user_message,
        assistant_text=clean_text,
        speaker_label=speaker_label,
        stm_trimmed=stm_trimmed,
    )
    agent._schedule_emotion_diary(
        user_message=user_message,
        assistant_text=clean_text,
        speaker_label=speaker_label,
        username=username,
        discord_user_id=discord_user_id,
    )
    for s in saved_facts:
        agent.diary.add_entry(
            text=f"Зафиксировала новый факт в досье: {s}",
            source="memory_update",
            meta={"username": username or "unknown"},
        )

    agent._publish_memory_and_chat_events(
        internal_user_id=internal_uid,
        channel_id=channel_id,
        username=username,
        user_message=user_message,
        clean_text=clean_text,
        sounds=sounds,
        metadata=metadata,
    )
    logger.debug("Ответ сгенерирован | sounds=%s | len=%s", sounds, len(clean_text))
    return metadata
