"""Anti-repeat paraphrase helper for consecutive similar assistant replies."""

from __future__ import annotations

import logging
from difflib import SequenceMatcher
from typing import Any, Callable

logger = logging.getLogger("neyra.agent.de_repeat")


async def de_repeat_reply(
    *,
    user_message: str,
    clean_text: str,
    short_memory: Any,
    llm_talk: Any,
    lyrics_marker: str,
    extract_think_blocks: Callable[[str], tuple[str, str]],
    extract_sound_tags: Callable[..., tuple[str, list[str]]],
) -> str:
    """
    If the new reply nearly duplicates the previous assistant message,
    ask talk LLM for a short paraphrase.
    """
    if lyrics_marker in (user_message or ""):
        return (clean_text or "").strip()
    text = (clean_text or "").strip()
    if not text:
        return text
    hist = short_memory.get_history()
    prev_assistant = ""
    for msg in reversed(hist):
        if msg.get("role") == "assistant":
            prev_assistant = str(msg.get("content") or "").strip()
            break
    if not prev_assistant:
        return text

    sim = SequenceMatcher(None, prev_assistant.lower(), text.lower()).ratio()
    if sim < 0.92:
        return text

    logger.warning("Anti-repeat: похожий ответ (similarity=%.2f), делаю перефраз", sim)
    try:
        from langchain_core.messages import HumanMessage, SystemMessage

        rewrite_llm = llm_talk.bind(max_tokens=90, temperature=0.9)
        resp = await rewrite_llm.ainvoke(
            [
                SystemMessage(
                    content=(
                        "Перефразируй реплику ассистента по-русски: коротко, живо, без markdown, "
                        "без тегов <think>/<thought>, без копирования той же фразы."
                    )
                ),
                HumanMessage(
                    content=(
                        f"Запрос пользователя: {user_message}\n"
                        f"Предыдущая реплика ассистента: {prev_assistant}\n"
                        f"Новая реплика-клон: {text}\n"
                        "Нужна новая формулировка с тем же смыслом."
                    )
                ),
            ]
        )
        raw = resp.content if hasattr(resp, "content") else str(resp)
        text_no_think, _ = extract_think_blocks(raw)
        alt, _ = extract_sound_tags(text_no_think)
        alt = (alt or "").strip()
        if alt and alt.lower() != prev_assistant.lower():
            return alt
    except Exception as e:
        logger.warning("Anti-repeat перефраз не удался: %s", e)
    return text
