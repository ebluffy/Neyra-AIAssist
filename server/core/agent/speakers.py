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
    """Nick/display label; real name only from explicit facts (Memory v2)."""
    from core.memory.person_profile import known_name_from_facts, speaker_ref_from_account

    u = (username or "").strip()
    disp = (author_display_name or "").strip()
    person = None
    if hub is not None and (u or discord_user_id):
        person = hub.find_person(u, discord_id=discord_user_id)
    if person:
        pid = str(person.get("id") or "").strip()
        facts: list = []
        try:
            facts = hub.list_person_facts(pid, limit=20) if hub is not None else []
        except Exception:
            facts = []
        known = known_name_from_facts(facts)
        handle = u
        for acc in person.get("accounts") or []:
            if str(acc.get("platform") or "").lower() == "discord":
                handle = str(acc.get("handle") or "").strip() or handle
                disp = str(acc.get("display_name") or "").strip() or disp
                break
        return speaker_ref_from_account(
            handle=handle or None,
            display_name=disp or None,
            known_name=known or None,
        )
    return disp or u or "user"


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
