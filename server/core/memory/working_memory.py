"""
Рабочая память (1–3 дня): компактный markdown-артефакт, переписывается memory_model
после успешных ходов чата; подмешивается в системный промпт до RAG.
"""

from __future__ import annotations

import logging
import re
import threading
from pathlib import Path
from typing import Any

from core.runtime.timeutil import now_local

logger = logging.getLogger("neyra.working_memory")

_LOCK = threading.RLock()


def project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def wm_config(config: dict) -> dict[str, Any]:
    mem = config.get("memory") if isinstance(config.get("memory"), dict) else {}
    raw = mem.get("working_memory") if isinstance(mem.get("working_memory"), dict) else {}
    return raw


def wm_enabled(config: dict) -> bool:
    return bool(wm_config(config).get("enabled", False))


def resolve_wm_path(config: dict, root: Path, internal_user_id: str) -> Path:
    w = wm_config(config)
    per_user = bool(w.get("per_user", True))
    if per_user:
        d = Path(str(w.get("storage_dir", "./data/memory/working_memory"))).expanduser()
        if not d.is_absolute():
            d = (root / d).resolve()
        d.mkdir(parents=True, exist_ok=True)
        safe = re.sub(r"[^\w.\-]+", "_", (internal_user_id or "unknown").strip())[:120] or "unknown"
        return d / f"{safe}.md"
    p = Path(str(w.get("shared_file_path", "./data/memory/working_memory.md"))).expanduser()
    if not p.is_absolute():
        p = (root / p).resolve()
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _default_template() -> str:
    ts = now_local().strftime("%Y-%m-%d %H:%M %Z")
    return (
        "# Рабочая память (1–3 дня)\n\n"
        f"_Последнее обновление: {ts}_\n\n"
        "## Активные договорённости и контекст\n"
        "- (пусто — заполнится автоматически по диалогам)\n\n"
        "## Короткие задачи / напоминания\n"
        "- \n"
    )


def read_snippet_for_prompt(config: dict, root: Path, internal_user_id: str) -> str:
    if not wm_enabled(config):
        return ""
    w = wm_config(config)
    cap = max(400, int(w.get("max_chars_in_prompt", 3500)))
    path = resolve_wm_path(config, root, internal_user_id)
    with _LOCK:
        if not path.exists():
            return ""
        try:
            raw = path.read_text(encoding="utf-8")
        except Exception as e:
            logger.warning("working_memory read: %s", e)
            return ""
    raw = raw.strip()
    if not raw:
        return ""
    if len(raw) <= cap:
        return raw
    tail = raw[-cap:]
    cut = tail.find("\n")
    if cut > 0 and cut < 400:
        tail = tail[cut + 1 :]
    return "[…фрагмент файла рабочей памяти, показан хвост для лимита промпта…]\n" + tail.strip()


def _strip_code_fence(text: str) -> str:
    t = (text or "").strip()
    if t.startswith("```"):
        lines = t.splitlines()
        if lines and lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        t = "\n".join(lines).strip()
    return t


async def refresh_working_memory_async(
    agent: Any,
    config: dict,
    *,
    root: Path,
    internal_user_id: str,
    user_message: str,
    assistant_text: str,
    stm_tail: str,
    speaker_label: str,
    reason: str,
) -> None:
    """Переписывает markdown-файл рабочей памяти через memory_model (llm_memory)."""
    if not wm_enabled(config):
        return
    w = wm_config(config)
    path = resolve_wm_path(config, root, internal_user_id)
    max_file = max(2000, int(w.get("max_file_chars", 12000)))
    max_out = max(256, int(w.get("llm_max_tokens", 1400)))
    hub = getattr(agent, "memory_hub", None)

    current = ""
    if hub is not None:
        try:
            snap = hub.sqlite.latest_wm_snapshot(user_id=internal_user_id)
            if snap and str(snap.get("content") or "").strip():
                current = str(snap["content"]).strip()
        except Exception as e:
            # Same as file-path: do not rewrite from empty template on read failure.
            logger.warning("working_memory Hub read for refresh: %s", e)
            return
        if not current:
            current = _default_template()
    else:
        with _LOCK:
            if not path.exists():
                current = _default_template()
                try:
                    path.write_text(current, encoding="utf-8")
                except Exception as e:
                    logger.warning("working_memory init file: %s", e)
                    return
            else:
                try:
                    current = path.read_text(encoding="utf-8")
                except Exception as e:
                    logger.warning("working_memory read for refresh: %s", e)
                    return

    from langchain_core.messages import HumanMessage, SystemMessage

    sys = SystemMessage(
        content=(
            "Ты служебный модуль «рабочей памяти» ассистента Нейра (горизонт 1–3 дня). "
            "Тебе дали текущий markdown-файл и свежий обмен. Верни ЦЕЛИКОМ новое содержимое файла markdown на русском, "
            "без пояснений снаружи и без оборачивания в code fence.\n"
            "Правила:\n"
            "- Сохрани смысл заголовка первой строки (# Рабочая память …) или очень близкий вариант.\n"
            "- Сразу после H1 добавь строку вида _Последнее обновление: <локальное время хоста ISO>_ с актуальным временем.\n"
            "- Убери устаревшее и явно выполненное; добавь новые договорённости, задачи, важные детали из обмена.\n"
            "- Не выдумывай факты, которых не было во входе.\n"
            "- Будь компактной: в приоритете буллеты, без воды; без тегов мышления.\n"
            f"- Жёсткий ориентир объёма: не больше ~{max_file} символов итогового файла."
        )
    )
    human = HumanMessage(
        content=(
            f"Причина обновления: {reason}\n"
            f"Собеседник (подпись): {speaker_label}\n\n"
            "ТЕКУЩИЙ ФАЙЛ:\n"
            f"{current[:65000]}\n\n"
            "СВЕЖИЙ ОБМЕН (эта реплика):\n"
            f"Пользователь:\n{user_message}\n\n"
            f"Нейра:\n{assistant_text}\n\n"
            "НЕДАВНИЙ ХВОСТ ИСТОРИИ (краткая память, уже после этой реплики):\n"
            f"{(stm_tail or '').strip()[:12000]}\n"
        )
    )
    try:
        from core.llm.retry import ainvoke_with_rate_limit_backoff

        llm = getattr(agent, "llm_memory", None) or getattr(agent, "llm_reflection", None) or agent.llm_talk
        call = llm.bind(max_tokens=max_out) if hasattr(llm, "bind") else llm
        resp = await ainvoke_with_rate_limit_backoff(call, [sys, human], lane="memory_model")
        raw = resp.content if hasattr(resp, "content") else str(resp)
        text = _strip_code_fence(str(raw or ""))
        if len(text) < 80:
            logger.info("working_memory: слишком короткий ответ модели — пропуск записи")
            return
        if len(text) > max_file:
            text = text[: max_file - 80].rstrip() + "\n\n…[обрезано по max_file_chars]…"
        if hub is None:
            # No Hub: markdown file remains the store (emergency/console-only use).
            with _LOCK:
                path.write_text(text.strip() + "\n", encoding="utf-8")
            logger.info("working_memory обновлён | path=%s | reason=%s | chars=%s", path, reason, len(text))
        hub_ok = False
        if hub is not None:
            try:
                hub.save_wm_snapshot(
                    text.strip(),
                    user_id=internal_user_id,
                    meta={"path": str(path), "reason": reason},
                    publish_event=False,
                )
                hub_ok = True
                logger.info(
                    "working_memory обновлён (Hub only) | user=%s | reason=%s | chars=%s",
                    internal_user_id,
                    reason,
                    len(text),
                )
            except Exception as e:
                logger.warning("working_memory→Hub write failed: %s", e)
        if hub is not None and not hub_ok:
            logger.error(
                "working_memory: Hub write failed — snapshot dropped (no file fallback when Hub attached) | user=%s",
                internal_user_id,
            )
            return
        bus = getattr(agent, "event_bus", None)
        if bus is not None and (hub is None or hub_ok):
            try:
                from core.runtime.event_bus import MEMORY_WORKING_MEMORY_UPDATED, CoreEvent

                bus.publish(
                    CoreEvent(
                        MEMORY_WORKING_MEMORY_UPDATED,
                        "core.memory.working_memory",
                        {"path": str(path), "user_id": internal_user_id, "reason": reason},
                    )
                )
            except Exception as e:
                logger.debug("working_memory event: %s", e)
    except Exception as e:
        logger.warning("working_memory refresh: %s", e)
