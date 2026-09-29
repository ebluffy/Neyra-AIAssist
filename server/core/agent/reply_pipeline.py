"""Post-LLM reply sanitization shared by chat / chat_stream."""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("neyra.agent.reply_pipeline")


def sanitize_raw_reply(
    agent: Any,
    raw_response: str,
    *,
    lyrics_mode: bool,
    mode_label: str = "chat",
) -> tuple[str, str, list[str]]:
    """
    Strip think / micro-plan / sound tags and ensure non-empty clean text.

    Returns (clean_text, thoughts, sounds). Caller may still run async retry / de-repeat.
    """
    text_no_think, thoughts = agent._extract_think_blocks(raw_response)
    text_no_think, micro_plan = agent._strip_leading_micro_plan(text_no_think)
    if micro_plan:
        logger.debug("Micro-plan captured | mode=%s | chars=%s", mode_label, len(micro_plan))
    text_no_think, hidden_final, unclosed_final = agent._strip_micro_plan_blocks(text_no_think)
    if hidden_final > 0:
        agent._micro_plan_metrics["filtered_final_chars"] += hidden_final
        agent._micro_plan_metrics["leak_detected"] += 1
        logger.warning(
            "Micro-plan leak sanitized | mode=%s | hidden_chars=%s | unclosed=%s",
            mode_label,
            hidden_final,
            unclosed_final,
        )
    if unclosed_final:
        agent._micro_plan_metrics["unclosed_blocks"] += 1

    clean_text, sounds = agent._extract_sound_tags(
        text_no_think, preserve_line_breaks=lyrics_mode
    )
    clean_text = agent._ensure_nonempty_reply(
        text_no_think, clean_text, preserve_line_breaks=lyrics_mode
    )
    return clean_text, thoughts, sounds


async def retry_short_reply_if_empty(
    agent: Any, messages: list[Any], current_text: str
) -> str:
    """If cleaned reply is the empty placeholder, ask talk LLM for one short phrase."""
    from core.agent.reply_postprocess import EMPTY_REPLY_PLACEHOLDER

    if (current_text or "").strip() != EMPTY_REPLY_PLACEHOLDER:
        return current_text
    try:
        from langchain_core.messages import SystemMessage

        guard = SystemMessage(
            content=(
                "Срочный повтор: ответь ОДНОЙ короткой фразой по-русски (до 18 слов), "
                "без тегов, скобок и внутреннего мышления."
            )
        )
        retry_messages = [messages[0], guard, *messages[1:]] if messages else [guard]
        resp = await agent.llm_talk.ainvoke(retry_messages)
        raw = resp.content if hasattr(resp, "content") else str(resp)
        text_no_think, _ = agent._extract_think_blocks(raw)
        clean, _ = agent._extract_sound_tags(text_no_think)
        clean = (clean or "").strip()
        if clean:
            logger.info("Пустой ответ восстановлен через short re-ask")
            return clean
    except Exception as e:
        logger.warning("Short re-ask ошибка: %s", e)
    return current_text


async def polish_clean_reply(
    agent: Any,
    *,
    user_message: str,
    clean_text: str,
    messages: list[Any],
) -> str:
    """Short re-ask if empty placeholder, then anti-repeat paraphrase."""
    clean_text = await retry_short_reply_if_empty(agent, messages, clean_text)
    return await agent._de_repeat_reply(user_message, clean_text)


def log_micro_plan_metrics(agent: Any) -> None:
    if not agent.micro_planning_enabled:
        return
    m = agent._micro_plan_metrics
    logger.debug(
        "Micro-plan metrics | stream_hidden=%s | final_hidden=%s | unclosed=%s | leaks=%s",
        m["filtered_stream_chars"],
        m["filtered_final_chars"],
        m["unclosed_blocks"],
        m["leak_detected"],
    )
