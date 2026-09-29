"""Speaker labels and HumanMessage construction for chat turns."""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger("neyra.agent.speakers")


def resolve_speaker_label(
    hub: Any,
    username: Optional[str],
    discord_user_id: Optional[str],
    author_display_name: Optional[str] = None,
) -> str:
    """Human-readable speaker label for STM / HumanMessage / system prompt."""
    u = (username or "").strip()
    disp = (author_display_name or "").strip()
    if u:
        person = hub.find_person(u, discord_id=discord_user_id)
        if person and person.get("names"):
            return f"{person['names'][0]} (Discord-ник: {u})"
        return disp or u
    if disp:
        return disp
    return "user"


def format_spoken_user_message(text: str, speaker_label: str) -> str:
    """Prefix authorship for the LLM context ([Пользователь …]: …)."""
    body = (text or "").strip()
    sl = (speaker_label or "").strip()
    if not sl:
        return body
    if body:
        return f"[Пользователь {sl}]: {body}"
    return f"[Пользователь {sl}]:"


def make_human_turn(
    user_message: str,
    vision_images: Optional[list[tuple[str, str]]] = None,
    *,
    speaker_label: Optional[str] = None,
    has_vision_llm: bool = False,
):
    """Build LangChain HumanMessage (text or multimodal VL parts)."""
    from langchain_core.messages import HumanMessage

    use_vl = bool(vision_images) and has_vision_llm
    if vision_images and not has_vision_llm:
        logger.warning(
            "Изображения в сообщении, но llm_vision нет: vision.enabled, vision.model или use_brain_model_for_vision "
            "(или brain/VL без мультимодальности)."
        )
    if use_vl:
        text = (user_message or "").strip() or "Что на изображении? Коротко по-русски."
        text = format_spoken_user_message(text, speaker_label or "")
        parts: list[dict] = [{"type": "text", "text": text}]
        for mime, b64 in vision_images:
            parts.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{mime};base64,{b64}",
                        "detail": "auto",
                    },
                }
            )
        return HumanMessage(content=parts)
    return HumanMessage(content=format_spoken_user_message(user_message, speaker_label or ""))
