"""
Необязательные метаданные наблюдаемого тона для LTM/фактов.
Все вызовы LLM — через memory_model (llm_memory), короткие лимиты.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from core.text_resources import prompt_text

logger = logging.getLogger("neyra.emotion")


def layer_cfg(config: dict) -> dict[str, Any]:
    mem = config.get("memory") if isinstance(config.get("memory"), dict) else {}
    raw = mem.get("emotional_layer") if isinstance(mem.get("emotional_layer"), dict) else {}
    return raw


def layer_enabled(config: dict) -> bool:
    return bool(layer_cfg(config).get("enabled", False))


async def compact_emotion_for_ltm(
    agent: Any,
    config: dict,
    *,
    user_message: str,
    assistant_text: str,
    speaker_label: str,
) -> str:
    """Одна короткая строка для metadata Chroma (диалог); пусто при ошибке/выключено."""
    cfg = layer_cfg(config)
    if not cfg.get("enabled", False) or not cfg.get("ltm_emotion_sync", False):
        return ""
    max_out = max(32, int(cfg.get("ltm_emotion_max_tokens", 180)))
    from langchain_core.messages import HumanMessage, SystemMessage

    sys = SystemMessage(
        content=prompt_text("tone.extract")
    )
    human = HumanMessage(
        content=(
            f"Speaker label: {speaker_label}\n\n"
            f"User message (excerpt):\n{(user_message or '')[:1200]}\n\n"
            f"Assistant reply (excerpt):\n{(assistant_text or '')[:1200]}"
        )
    )
    try:
        from core.llm.retry import ainvoke_with_rate_limit_backoff

        llm = getattr(agent, "llm_memory", None) or getattr(agent, "llm_reflection", None) or agent.llm_talk
        call = llm.bind(max_tokens=max_out) if hasattr(llm, "bind") else llm
        resp = await ainvoke_with_rate_limit_backoff(call, [sys, human], lane="memory_model")
        raw = resp.content if hasattr(resp, "content") else str(resp)
        line = re.sub(r"\s+", " ", str(raw or "").strip())
        if len(line) > 220:
            line = line[:217] + "…"
        return line
    except Exception as e:
        logger.warning("ltm_emotion_sync: %s", e)
        return ""
