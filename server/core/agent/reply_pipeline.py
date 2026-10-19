"""Post-LLM reply sanitization shared by chat / chat_stream."""

from __future__ import annotations

import logging
from typing import Any

from core.text_resources import prompt_text

logger = logging.getLogger("neyra.agent.reply_pipeline")
CHARS_PER_TOKEN = 4


def visible_token_budget(agent: Any, lyrics_mode: bool = False) -> int:
    if lyrics_mode:
        return max(1, int(getattr(agent, "lyrics_reply_max_tokens", 4096)))
    return max(1, int(getattr(agent, "reply_max_tokens", 320)))


def clip_visible_reply(text: str, token_budget: int) -> str:
    """Keep the shown reply inside the visible token budget. The API budget may be larger."""
    limit = max(1, int(token_budget)) * CHARS_PER_TOKEN
    if not text or len(text) <= limit:
        return text
    cut = text[:limit]
    space = cut.rfind(" ")
    if space >= limit * 3 // 4:
        cut = cut[:space]
    return cut.rstrip()


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
        text_no_think, preserve_line_breaks=True
    )
    clean_text = agent._ensure_nonempty_reply(
        text_no_think, clean_text, preserve_line_breaks=True
    )
    return clean_text, thoughts, sounds


async def retry_short_reply_if_empty(
    agent: Any, messages: list[Any], current_text: str, *, lyrics_mode: bool = False
) -> str:
    """Retry an empty reply while preserving the turn's output requirements."""
    from core.agent.reply_postprocess import EMPTY_REPLY_PLACEHOLDER

    if (current_text or "").strip() != EMPTY_REPLY_PLACEHOLDER:
        return current_text
    try:
        from langchain_core.messages import SystemMessage
        from core.agent.model_trace import turn_conversation_mode
        structured = lyrics_mode or turn_conversation_mode(agent.config) in ("detailed", "technical")
        instruction = (
            prompt_text("reply.retry_complete")
            if structured else prompt_text("reply.retry_plain")
        )

        guard = SystemMessage(
            content=(
                prompt_text("reply.retry_lane") + instruction +
                prompt_text("reply.retry_constraints")
            )
        )
        context_messages = list(messages)
        if context_messages and context_messages[-1].type == "ai":
            context_messages.pop()
        retry_messages = [context_messages[0], guard, *context_messages[1:]] if context_messages else [guard]
        from core.agent.model_trace import invoke
        from core.agent.talk_sessions import responses_talk_model
        resp = await invoke(agent, responses_talk_model(agent, agent.llm_talk), retry_messages, lane="talk", purpose="empty_reply_retry")
        raw = resp.content if hasattr(resp, "content") else str(resp)
        clean, _, _ = sanitize_raw_reply(agent, raw, lyrics_mode=lyrics_mode, mode_label="empty_reply_retry")
        if clean and clean != EMPTY_REPLY_PLACEHOLDER:
            logger.info("Empty reply recovered through short re-ask")
            return clean
    except Exception as e:
        logger.warning("Short re-ask failed: %s", e)
    return current_text


async def polish_clean_reply(
    agent: Any,
    *,
    user_message: str,
    clean_text: str,
    messages: list[Any],
    lyrics_mode: bool,
) -> str:
    """Retry an empty reply, then apply the anti-repeat paraphrase."""
    clean_text = await retry_short_reply_if_empty(
        agent, messages, clean_text, lyrics_mode=lyrics_mode
    )
    return await agent._de_repeat_reply(user_message, clean_text, messages=messages)


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
