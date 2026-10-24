"""Persist turn side-effects after a successful reply (STM / Hub / jobs / events)."""

from __future__ import annotations

import asyncio
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
    from core.agent.model_trace import ACTIVE_TRACE
    active_scope = getattr(ACTIVE_TRACE.get(), "conversation_scope", None)
    if active_scope is not None and active_scope.kind == "shared":
        spoken_user = f"[author_id: {discord_user_id}]\n" + spoken_user
    from contextlib import nullcontext
    gate = getattr(ACTIVE_TRACE.get(), "conversation_gate", None)
    with gate.manager.lock if gate else nullcontext():
        if gate:
            gate.ensure_current()
        agent.short_memory.add("user", spoken_user)
        agent.short_memory.add("assistant", clean_text)

    metadata = {
        "username": username or "unknown",
        "discord_id": discord_user_id or "",
        "user_id": internal_uid,
        "visibility": "channel" if active_scope is not None and active_scope.kind == "shared" else "private",
    }
    if isinstance(extra_meta, dict) and extra_meta:
        metadata.update(extra_meta)
    from core.agent.model_trace import snapshot
    trace = snapshot()
    if trace is not None:
        metadata["model_trace"] = trace
    await agent._append_turn_to_chat_log(
        user_text=spoken_user,
        assistant_text=clean_text,
        internal_user_id=internal_uid,
        display_name=username or speaker_label,
        channel_id=channel_id,
        source=source,
        meta=metadata,
    )
    hub = getattr(agent, "memory_hub", None)
    active = ACTIVE_TRACE.get()
    if hub is not None and active is not None and active.affect_generations is not None:
        try:
            await asyncio.to_thread(hub.apply_affect_turn, turn_id=active.id, discord_id=discord_user_id,
                                  text=user_message, generations=active.affect_generations)
        except Exception:
            logger.exception("Assistant state update failed")
    if hub is None or getattr(hub, "rag_write_mode", "off") != "off":
        from core.agent.model_trace import spawn_background
        spawn_background(agent, "semantic_dialog", lambda: agent._save_dialog_to_ltm_with_emotion(
            user_message, clean_text, metadata, speaker_label))

    agent._log_thought(thoughts, user_message)
    agent._log_chat(user_message, clean_text, metadata)
    agent._store_vision_note_if_needed(channel_id, vision_images, thoughts, clean_text)
    from core.agent.memory_jobs import schedule_turn_diary
    schedule_turn_diary(agent, user_message=user_message, assistant_text=clean_text,
                        internal_user_id=internal_uid, channel_id=channel_id,
                        speaker_label=speaker_label)
    agent._schedule_working_memory_refresh(
        internal_user_id=internal_uid,
        user_message=user_message,
        assistant_text=clean_text,
        speaker_label=speaker_label,
        stm_trimmed=stm_trimmed,
    )
    for s in saved_facts:
        agent.diary.add_entry(
            text=f"Зафиксировала новый факт в досье: {s}",
            source="memory_update",
            meta={"username": username or "unknown", "user_id": internal_uid, "channel_id": channel_id},
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
