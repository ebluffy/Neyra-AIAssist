"""Vision caption + last-image note helpers for talk prompt continuity."""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger("neyra.agent.vision_context")


async def caption_vision_images(
    agent: Any,
    user_message: str,
    vision_images: list[tuple[str, str]],
    *,
    speaker_label: str,
) -> str:
    """Short Russian caption via VL model (before brain/talk)."""
    from langchain_core.messages import SystemMessage

    if not vision_images or not agent.llm_vision:
        return ""
    sys = SystemMessage(
        content=(
            "Ты модуль зрения. Кратко по-русски опиши, что на изображении (1–8 предложений). "
            "Несколько картинок — перечисли по порядку. Текст на экране — по возможности дословно. "
            "Без личности ассистента, без markdown-заголовков."
        )
    )
    human = agent._make_human_turn(
        (user_message or "").strip() or "Что на изображении?",
        vision_images,
        speaker_label=speaker_label,
    )
    resp = await agent.llm_vision.ainvoke([sys, human])
    raw = resp.content if hasattr(resp, "content") else str(resp)
    caption = (raw or "").strip()
    agent._log_model_route(agent._extract_model_name(resp), lane="vision")
    return caption


def make_vision_memory_note(
    thoughts: str,
    clean_text: str,
    *,
    max_chars: int = 1200,
) -> str:
    """Prefer CoT/think from VL reply; fall back to short clean answer."""
    t = (thoughts or "").strip()
    if t:
        body = t
    else:
        c = (clean_text or "").strip()
        if not c:
            return ""
        body = (
            "(в ответе API не было блока think/thought) Кратко что ответила по скрину: "
            + c
        )
    if len(body) > max_chars:
        body = body[: max_chars - 1] + "…"
    return body


def last_image_context_for_prompt(
    store: dict[str, str],
    channel_id: Optional[str],
    vision_images: Optional[list],
    *,
    remember_last_image: bool = True,
) -> Optional[str]:
    if not remember_last_image or vision_images or not channel_id:
        return None
    return store.get(str(channel_id))


def store_vision_note_if_needed(
    store: dict[str, str],
    channel_id: Optional[str],
    vision_images: Optional[list],
    thoughts: str,
    clean_text: str,
    *,
    remember_last_image: bool = True,
    max_chars: int = 1200,
) -> None:
    if not channel_id or not vision_images or not remember_last_image:
        return
    note = make_vision_memory_note(thoughts, clean_text, max_chars=max_chars)
    if note:
        store[str(channel_id)] = note
        logger.debug("Зрение: заметка по каналу %s (%s симв.)", channel_id, len(note))
