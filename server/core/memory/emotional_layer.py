"""
Эмоциональный слой памяти: реакция персонажа в дневнике и метаданные для LTM/фактов.
Все вызовы LLM — через memory_model (llm_memory), короткие лимиты.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Optional

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
        content=(
            "Ты служебный модуль: одна строка (до 220 символов) — внутреннее настроение/тон Нейры ПОСЛЕ этого ответа. "
            "Без кавычек, без markdown, без перечня. Не пересказывай факты чата; не цитируй оскорбления дословно; "
            "не воспроизводи пароли, токены, адреса."
        )
    )
    human = HumanMessage(
        content=(
            f"Собеседник: {speaker_label}\n\n"
            f"Реплика пользователя (сжато):\n{(user_message or '')[:1200]}\n\n"
            f"Ответ Нейры (сжато):\n{(assistant_text or '')[:1200]}\n\n"
            "Дай одну строку настроения."
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


async def diary_emotion_after_turn_async(
    agent: Any,
    config: dict,
    *,
    user_message: str,
    assistant_text: str,
    speaker_label: str,
    username: Optional[str],
    discord_user_id: Optional[str],
) -> None:
    """Запись в дневник: короткая эмоциональная реакция персонажа на ход."""
    cfg = layer_cfg(config)
    if not cfg.get("enabled", False) or not cfg.get("diary_after_turn", True):
        return
    cap = max(80, int(cfg.get("max_diary_emotion_chars", 480)))
    max_out = max(64, int(cfg.get("diary_emotion_max_tokens", 350)))
    from langchain_core.messages import HumanMessage, SystemMessage

    sys = SystemMessage(
        content=(
            "Ты Нейра. Напиши 1–3 коротких предложения для ЛИЧНОГО дневника: что ты почувствовала/о чём переживаешь "
            "после этого обмена (тон, ирония, лёгкая усталость — как уместно). От первого лица, по-русски. "
            "Без markdown и списков. Не пересказывай дословно реплики; не цитируй токсик дословно; "
            "не свети секреты и приватные данные."
        )
    )
    human = HumanMessage(
        content=(
            f"Собеседник: {speaker_label}\n\n"
            f"Пользователь (сжато):\n{(user_message or '')[:2000]}\n\n"
            f"Твой ответ (сжато):\n{(assistant_text or '')[:2000]}\n"
        )
    )
    try:
        from core.llm.retry import ainvoke_with_rate_limit_backoff

        llm = getattr(agent, "llm_memory", None) or getattr(agent, "llm_reflection", None) or agent.llm_talk
        call = llm.bind(max_tokens=max_out) if hasattr(llm, "bind") else llm
        resp = await ainvoke_with_rate_limit_backoff(call, [sys, human], lane="memory_model")
        note = (resp.content if hasattr(resp, "content") else str(resp)).strip()
        note = re.sub(r"\s+", " ", note)
        if not note:
            return
        if len(note) > cap:
            note = note[: cap - 1] + "…"
        diary = getattr(agent, "diary", None)
        if diary is None:
            return
        diary.add_entry(
            text=note,
            source="emotion_turn",
            meta={
                "username": username or "unknown",
                "discord_id": discord_user_id or "",
                "speaker_label": speaker_label[:200],
            },
        )
        logger.debug("emotion_turn: дневник +%s симв.", len(note))
    except Exception as e:
        logger.warning("diary_emotion_after_turn: %s", e)
