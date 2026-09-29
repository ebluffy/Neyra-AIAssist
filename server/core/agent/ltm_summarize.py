"""LTM corpus summarization for maintenance / consolidation."""

from __future__ import annotations

from typing import Any


async def summarize_ltm_corpus(
    agent: Any,
    combined_dialog_text: str,
    *,
    consolidation: bool = False,
) -> str:
    """
    Compress old dialog fragments into a short RAG digest (memory_model lane).
    consolidation=True merges duplicates / drops noise for nightly jobs.
    """
    from langchain_core.messages import HumanMessage

    from core.llm.retry import ainvoke_with_rate_limit_backoff

    raw = (combined_dialog_text or "").strip()
    if not raw:
        return ""
    cap = 120_000
    if len(raw) > cap:
        raw = raw[: cap - 100] + "\n… [truncated for summarization]"

    mem_cfg = agent.config.get("memory") if isinstance(agent.config.get("memory"), dict) else {}
    if agent.reflection_max_tokens is not None:
        default_summarize = min(agent.reflection_max_tokens * 2, 4096)
    else:
        default_summarize = 4096
    max_out = int(mem_cfg.get("ltm_summarize_max_tokens", default_summarize))
    if consolidation:
        prompt = (
            "Ниже — близкие по смыслу фрагменты долговременной памяти (один кластер). "
            "Объедини явные дубли и повторы одной мысли; убери шум и пустяки без потери фактов. "
            "Если темы разные — структурируй короткими подзаголовками (markdown ##). "
            "Только русский; не выдумывай факты; если мало сигнала — 2–4 предложения.\n\n---\n\n"
            f"{raw}"
        )
    else:
        prompt = (
            "Ниже — фрагменты старых диалогов из долговременной памяти. "
            "Сожми их в один связный markdown-текст на русском: темы, имена, факты, без воды и без выдумок. "
            "Если данных мало — дай 2–4 предложения.\n\n---\n\n"
            f"{raw}"
        )
    llm = getattr(agent, "llm_memory", None) or getattr(agent, "llm_reflection", None) or agent.llm_talk
    call = llm.bind(max_tokens=max_out) if hasattr(llm, "bind") else llm
    resp = await ainvoke_with_rate_limit_backoff(
        call, [HumanMessage(content=prompt)], lane="memory_model"
    )
    text = getattr(resp, "content", None)
    return (str(text) if text is not None else "").strip()
