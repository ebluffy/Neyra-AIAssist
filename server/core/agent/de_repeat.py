"""Anti-repeat paraphrase helper for consecutive similar assistant replies."""

from __future__ import annotations

import logging
from difflib import SequenceMatcher
from typing import Any, Callable

from core.text_resources import prompt_text
from .conversation_modes import conversation_mode_hint
from .micro_plan import MicroPlanSettings, strip_leading, strip_blocks

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
    conversation_mode: str = "default",
    reply_max_tokens: int = 90,
    persona: str = "",
    turn_messages: list[Any] | None = None,
    micro_plan: MicroPlanSettings | None = None,
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

    logger.warning("Anti-repeat: similar reply (similarity=%.2f), rewriting", sim)
    try:
        from langchain_core.messages import HumanMessage, SystemMessage

        rewrite_llm = llm_talk.bind(
            max_tokens=min(reply_max_tokens, 90) if conversation_mode == "brief" else reply_max_tokens,
            temperature=0.9,
        )
        instruction = (
            prompt_text("rewrite.detailed")
            if conversation_mode != "brief" else
            prompt_text("rewrite.brief")
        )
        rewrite_messages = [
            SystemMessage(
                content=(
                    (persona + "\n" if not turn_messages else "")
                    + instruction + prompt_text("rewrite.private_reasoning_rule")
                    + "\n" + conversation_mode_hint(conversation_mode)
                )
            ),
            HumanMessage(
                content=(
                    f"User request: {user_message}\n"
                    f"Previous assistant reply: {prev_assistant}\n"
                    f"Duplicate candidate: {text}\n"
                    "Return a fresh formulation with the same meaning."
                )
            ),
        ]
        if turn_messages:
            # Preserve the original persona, scoped context and state on this talk call.
            context_messages = list(turn_messages)
            if context_messages[-1].type == "ai":
                context_messages.pop()
            rewrite_messages = [context_messages[0], rewrite_messages[0], *context_messages[1:], rewrite_messages[1]]
        from core.agent.model_trace import invoke
        resp = await invoke(None, rewrite_llm, rewrite_messages, lane="talk", purpose="rewrite")
        raw = resp.content if hasattr(resp, "content") else str(resp)
        text_no_think, _ = extract_think_blocks(raw)
        if micro_plan is not None:
            text_no_think, _ = strip_leading(text_no_think, micro_plan)
            text_no_think, _, _ = strip_blocks(text_no_think, micro_plan)
        alt, _ = extract_sound_tags(text_no_think, preserve_line_breaks=True)
        alt = (alt or "").strip()
        if alt and alt.lower() != prev_assistant.lower():
            return alt
    except Exception as e:
        logger.warning("Anti-repeat rewrite failed: %s", e)
    return text
