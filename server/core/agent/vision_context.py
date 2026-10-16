"""Vision caption + last-image note helpers for talk prompt continuity."""

from __future__ import annotations

import logging
from typing import Any, Optional

from core.text_resources import prompt_text

logger = logging.getLogger("neyra.agent.vision_context")


async def caption_vision_images(
    agent: Any,
    user_message: str,
    vision_images: list[tuple[str, str]],
    *,
    speaker_label: str,
    discord_context=None,
) -> str:
    """Produce a bounded image caption before brain/talk."""
    from langchain_core.messages import HumanMessage, SystemMessage

    if not vision_images or not agent.llm_vision:
        return ""
    sys = SystemMessage(
        content=prompt_text("vision.caption")
    )
    from core.agent.discord_context import context_prompt
    human = agent._make_human_turn(
        (user_message or "").strip() or prompt_text("vision.default_question"),
        vision_images,
        speaker_label=speaker_label,
    )
    from core.agent.model_trace import invoke
    messages = [sys]
    if discord_context is not None:
        messages.append(HumanMessage(content=context_prompt(discord_context)))
    messages.append(human)
    resp = await invoke(agent, agent.llm_vision, messages, lane="vision", purpose="caption", images=True)
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
    """Keep only the public response; never carry private reasoning across lanes."""
    c = (clean_text or "").strip()
    if not c:
        return ""
    body = "Previous user-facing image response (not current pixel input): " + c
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
        logger.debug("Vision note stored for channel %s (%s chars)", channel_id, len(note))
