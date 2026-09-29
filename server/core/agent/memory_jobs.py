"""Background memory jobs: async reflection, WM refresh, emotion diary."""

from __future__ import annotations

import asyncio
import logging
import re
import time
from typing import Any, Optional

logger = logging.getLogger("neyra.agent.memory_jobs")


async def run_async_reflection(
    agent: Any,
    user_message: str,
    assistant_text: str,
    username: Optional[str],
    discord_user_id: Optional[str],
) -> None:
    if not agent.async_reflection_enabled:
        return
    try:
        from langchain_core.messages import HumanMessage, SystemMessage

        from core.llm.retry import ainvoke_with_rate_limit_backoff

        ar = agent.async_reflection_cfg if isinstance(agent.async_reflection_cfg, dict) else {}
        ar_bind: dict[str, Any] = {
            "temperature": float(ar.get("temperature", agent.reflection_temperature)),
        }
        ar_max = ar.get("max_tokens")
        if ar_max is not None:
            ar_bind["max_tokens"] = int(ar_max)
        elif agent.reflection_max_tokens is not None:
            ar_bind["max_tokens"] = agent.reflection_max_tokens
        else:
            ar_bind["max_tokens"] = 500
        llm_ar = agent.llm_memory.bind(**ar_bind)

        sys_prompt = (
            "Ты внутренний аналитический модуль Нейры. "
            "Сформируй краткий (4-8 предложений) анализ микро-диалога: "
            "намерение пользователя, эмоции, качество ответа и что стоит запомнить на будущее. "
            "Не пиши теги <think>, markdown и служебные поля."
        )
        human = (
            f"Пользователь ({username or 'unknown'}, discord_id={discord_user_id or ''}) сказал:\n"
            f"{user_message}\n\n"
            f"Нейра ответила:\n{assistant_text}\n\n"
            "Сделай полезную заметку для дневника."
        )
        resp = await ainvoke_with_rate_limit_backoff(
            llm_ar,
            [SystemMessage(content=sys_prompt), HumanMessage(content=human)],
            lane="memory_model",
        )
        note = (resp.content if hasattr(resp, "content") else str(resp)).strip()
        note = re.sub(r"\s+", " ", note).strip()
        if not note:
            return
        max_chars = int(agent.async_reflection_cfg.get("max_note_chars", 1200))
        if len(note) > max_chars:
            note = note[: max_chars - 1] + "…"
        agent.diary.add_entry(
            text=note,
            source="async_reflection",
            meta={"username": username or "unknown", "discord_id": discord_user_id or ""},
        )
        logger.debug("Async reflection: запись в дневник добавлена (%s симв.)", len(note))
    except Exception as e:
        logger.warning("Async reflection ошибка: %s", e)


def schedule_async_reflection(
    agent: Any,
    user_message: str,
    assistant_text: str,
    username: Optional[str],
    discord_user_id: Optional[str],
) -> None:
    if not agent.async_reflection_enabled:
        return
    try:
        asyncio.create_task(
            run_async_reflection(
                agent,
                user_message=user_message,
                assistant_text=assistant_text,
                username=username,
                discord_user_id=discord_user_id,
            )
        )
    except Exception as e:
        logger.warning("Не удалось запланировать async reflection: %s", e)


def format_stm_tail(short_memory: Any, max_messages: int = 12) -> str:
    lines: list[str] = []
    for m in short_memory.get_history()[-max_messages:]:
        role = str(m.get("role") or "")
        content = str(m.get("content") or "")
        label = "Пользователь" if role == "user" else "Нейра"
        chunk = content if len(content) <= 1600 else content[:1597] + "…"
        lines.append(f"{label}: {chunk}")
    return "\n".join(lines)


async def run_working_memory_refresh(
    agent: Any,
    *,
    internal_user_id: str,
    user_message: str,
    assistant_text: str,
    speaker_label: str,
    reason: str,
) -> None:
    from core.memory import working_memory as wm

    await wm.refresh_working_memory_async(
        agent,
        agent.config,
        root=agent._project_root,
        internal_user_id=internal_user_id,
        user_message=user_message,
        assistant_text=assistant_text,
        stm_tail=format_stm_tail(agent.short_memory, 12),
        speaker_label=speaker_label,
        reason=reason,
    )


def schedule_working_memory_refresh(
    agent: Any,
    *,
    internal_user_id: str,
    user_message: str,
    assistant_text: str,
    speaker_label: str,
    stm_trimmed: bool = False,
) -> None:
    from core.memory import working_memory as wm

    if not wm.wm_enabled(agent.config):
        return
    cfg = wm.wm_config(agent.config)
    force = bool(stm_trimmed and cfg.get("update_after_context_trim", True))
    agent._wm_turns_since_refresh += 1
    every = max(1, int(cfg.get("update_every_n_turns", 2)))
    should = force or agent._wm_turns_since_refresh >= every
    if not should:
        return
    gap = float(cfg.get("min_interval_seconds", 30))
    if gap > 0 and not force and (time.monotonic() - agent._wm_last_refresh_mono) < gap:
        return
    agent._wm_turns_since_refresh = 0
    agent._wm_last_refresh_mono = time.monotonic()
    try:
        asyncio.create_task(
            run_working_memory_refresh(
                agent,
                internal_user_id=internal_user_id,
                user_message=user_message,
                assistant_text=assistant_text,
                speaker_label=speaker_label,
                reason="context_trim" if stm_trimmed else f"every_{every}_turns",
            )
        )
    except Exception as e:
        logger.warning("Не удалось запланировать working_memory: %s", e)


async def save_dialog_to_ltm_with_emotion(
    agent: Any,
    user_message: str,
    clean_text: str,
    metadata: dict,
    speaker_label: str,
) -> None:
    from core.memory import emotional_layer as el

    md = dict(metadata)
    if el.layer_enabled(agent.config) and el.layer_cfg(agent.config).get("ltm_emotion_sync"):
        tag = await el.compact_emotion_for_ltm(
            agent,
            agent.config,
            user_message=user_message,
            assistant_text=clean_text,
            speaker_label=speaker_label,
        )
        if tag:
            md["assistant_emotion"] = tag
    hub = getattr(agent, "memory_hub", None)
    if hub is not None:
        hub.save_dialog_semantic(user_message, clean_text, md)
    else:
        agent.long_memory.save(user_message, clean_text, md)


def schedule_emotion_diary(
    agent: Any,
    *,
    user_message: str,
    assistant_text: str,
    speaker_label: str,
    username: Optional[str],
    discord_user_id: Optional[str],
) -> None:
    from core.memory import emotional_layer as el

    if not el.layer_enabled(agent.config) or not el.layer_cfg(agent.config).get("diary_after_turn", True):
        return
    gap = float(el.layer_cfg(agent.config).get("diary_emotion_min_interval_seconds", 90))
    if gap > 0 and (time.monotonic() - agent._emotion_last_mono) < gap:
        return
    agent._emotion_last_mono = time.monotonic()
    try:
        asyncio.create_task(
            el.diary_emotion_after_turn_async(
                agent,
                agent.config,
                user_message=user_message,
                assistant_text=assistant_text,
                speaker_label=speaker_label,
                username=username,
                discord_user_id=discord_user_id,
            )
        )
    except Exception as e:
        logger.warning("Не удалось запланировать emotional_layer diary: %s", e)
