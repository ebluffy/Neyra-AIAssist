"""OpenAI-compatible LLM wiring for NeyraAgent (talk / brain / memory / vision).

Supports dual-backend: each role sets ``llm.<role>.provider``
(e.g. talk → openrouter, brain/memory/vision → aihope).
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("neyra.agent.llm_setup")

DEPRECATED_OPENROUTER_MODELS: dict[str, str] = {
    "openrouter/elephant-alpha": "inclusionai/ling-2.6-flash:free",
}


def setup_llm_connection(agent: Any) -> None:
    """Resolve default + per-role provider connections and build ChatOpenAI clients."""
    from core.llm.profile import resolve_openai_compatible_connection

    agent._llm_conn_talk = resolve_openai_compatible_connection(agent.config, role="talk_model")
    agent._llm_conn_brain = resolve_openai_compatible_connection(agent.config, role="brain_model")
    agent._llm_conn_memory = resolve_openai_compatible_connection(agent.config, role="memory_model")
    agent._llm_conn_vision = resolve_openai_compatible_connection(agent.config, role="vision_model")
    agent._llm_connection = agent._llm_conn_talk
    agent.backend = agent._llm_conn_talk.provider
    agent.llm_role_providers = {
        "talk": agent._llm_conn_talk.provider,
        "brain": agent._llm_conn_brain.provider,
        "memory": agent._llm_conn_memory.provider,
        "vision": agent._llm_conn_vision.provider,
    }
    agent.llm_dual = (
        len(
            {
                agent._llm_conn_talk.provider,
                agent._llm_conn_brain.provider,
                agent._llm_conn_memory.provider,
                agent._llm_conn_vision.provider,
            }
        )
        > 1
    )
    setup_openai_compatible_llm(agent)


def setup_openai_compatible_llm(agent: Any) -> None:
    """Build ChatOpenAI clients; each role may use a different provider connection."""
    from langchain_openai import ChatOpenAI

    from core.llm.profile import (
        merge_llm_tuning_options,
        resolved_brain_model,
        resolved_memory_model,
        resolved_talk_model,
        resolved_vision_model_id,
    )

    conn_default = agent._llm_connection
    conn_talk = getattr(agent, "_llm_conn_talk", None) or conn_default
    conn_brain = getattr(agent, "_llm_conn_brain", None) or conn_default
    conn_memory = getattr(agent, "_llm_conn_memory", None) or conn_default
    conn_vision = getattr(agent, "_llm_conn_vision", None) or conn_default

    cfg = merge_llm_tuning_options(agent.config)
    talk_model = resolved_talk_model(agent.config, conn_talk.provider)
    brain_model = resolved_brain_model(agent.config, conn_brain.provider)
    memory_model_raw = resolved_memory_model(agent.config, conn_memory.provider)
    memory_model = DEPRECATED_OPENROUTER_MODELS.get(memory_model_raw, memory_model_raw)
    if memory_model != memory_model_raw:
        logger.warning(
            "Memory model '%s' is deprecated, using '%s' instead.",
            memory_model_raw,
            memory_model,
        )
    vision_model_id = resolved_vision_model_id(agent.config, conn_vision.provider)
    agent.reply_max_tokens = int(cfg.get("reply_max_tokens", 320))
    agent.vision_max_tokens = int(cfg.get("vision_max_tokens", 900))
    _refl_cap = cfg.get("reflection_max_tokens")
    agent.reflection_max_tokens = int(_refl_cap) if _refl_cap is not None else None
    agent.lyrics_reply_max_tokens = int(cfg.get("lyrics_reply_max_tokens", 4096))
    agent.reflection_temperature = float(
        cfg.get("reflection_temperature", cfg.get("temperature", 0.75))
    )
    _brain_cap = cfg.get("brain_max_tokens")
    agent.brain_max_tokens = int(_brain_cap) if _brain_cap is not None else None
    agent.brain_temperature = float(cfg.get("brain_temperature", 0.35))

    for label, conn in (
        ("talk", conn_talk),
        ("brain", conn_brain),
        ("memory", conn_memory),
        ("vision", conn_vision),
    ):
        if not conn.api_key or conn.api_key == "ollama":
            if conn.provider != "ollama":
                logger.error(
                    "API ключ LLM (%s/%s) не найден — задай env AIHOPE_API_KEY / OPENROUTER_API_KEY "
                    "или llm.providers.%s.api_key",
                    label,
                    conn.provider,
                    conn.provider,
                )

    talk_timeout = float(cfg.get("timeout_seconds", cfg.get("primary_timeout_seconds", 120.0)))
    talk_retries = int(cfg.get("max_retries", cfg.get("primary_max_retries", 1)))
    brain_timeout = float(cfg.get("brain_timeout_seconds", cfg.get("timeout_seconds", talk_timeout)))
    brain_retries = int(cfg.get("brain_max_retries", cfg.get("max_retries", talk_retries)))
    ar_cfg0 = cfg.get("async_reflection") if isinstance(cfg.get("async_reflection"), dict) else {}
    reflection_timeout = float(
        cfg.get("reflection_timeout_seconds", ar_cfg0.get("timeout_seconds", talk_timeout))
    )
    reflection_retries = int(
        cfg.get("reflection_max_retries", ar_cfg0.get("max_retries", talk_retries))
    )
    extra_body: dict[str, Any] = {}
    if "reasoning_enabled" in cfg:
        extra_body["reasoning_enabled"] = bool(cfg.get("reasoning_enabled"))
    if "include_reasoning" in cfg:
        extra_body["include_reasoning"] = bool(cfg.get("include_reasoning"))

    hdr_talk = dict(conn_talk.default_headers)
    agent.llm_talk = ChatOpenAI(
        base_url=conn_talk.base_url,
        api_key=conn_talk.api_key,
        model=talk_model,
        temperature=cfg.get("temperature", 0.75),
        top_p=float(cfg.get("top_p", 1.0)),
        presence_penalty=float(cfg.get("presence_penalty", 0.0)),
        frequency_penalty=float(cfg.get("frequency_penalty", 0.0)),
        max_tokens=agent.reply_max_tokens,
        streaming=True,
        timeout=talk_timeout,
        max_retries=talk_retries,
        model_kwargs={"extra_body": extra_body} if extra_body else {},
        default_headers=hdr_talk,
    )
    agent.llm_talk = agent.llm_talk.bind(
        stop=[
            "<think>",
            "</think>",
            "<thought>",
            "</thought>",
            "<redacted_thinking>",
            "</redacted_thinking>",
        ]
    )

    hdr_brain = dict(conn_brain.default_headers)
    hdr_brain["X-Title"] = "Neyra Brain"
    brain_llm_kwargs: dict[str, Any] = {
        "base_url": conn_brain.base_url,
        "api_key": conn_brain.api_key,
        "model": brain_model,
        "temperature": agent.brain_temperature,
        "top_p": float(cfg.get("brain_top_p", cfg.get("top_p", 1.0))),
        "streaming": False,
        "timeout": brain_timeout,
        "max_retries": brain_retries,
        "model_kwargs": {"extra_body": extra_body} if extra_body else {},
        "default_headers": hdr_brain,
    }
    if agent.brain_max_tokens is not None:
        brain_llm_kwargs["max_tokens"] = agent.brain_max_tokens
    agent.llm_brain = ChatOpenAI(**brain_llm_kwargs)

    hdr_memory = dict(conn_memory.default_headers)
    hdr_memory["X-Title"] = "Neyra Memory"
    memory_llm_kwargs: dict[str, Any] = {
        "base_url": conn_memory.base_url,
        "api_key": conn_memory.api_key,
        "model": memory_model,
        "temperature": agent.reflection_temperature,
        "streaming": False,
        "timeout": reflection_timeout,
        "max_retries": reflection_retries,
        "default_headers": hdr_memory,
    }
    if agent.reflection_max_tokens is not None:
        memory_llm_kwargs["max_tokens"] = agent.reflection_max_tokens
    agent.llm_memory = ChatOpenAI(**memory_llm_kwargs)
    agent.llm_reflection = agent.llm_memory
    agent.llm_memory_model = memory_model
    agent.llm_reflection_model = memory_model

    agent.llm_primary = agent.llm_talk
    agent.llm = agent.llm_talk
    agent.llm_model = talk_model
    agent.llm_talk_model = talk_model
    agent.llm_primary_model = talk_model
    agent.llm_brain_model = brain_model
    agent.llm_fallback_model = None
    agent.primary_first_token_timeout = float(
        cfg.get("primary_first_token_timeout_seconds", talk_timeout)
    )
    agent.async_reflection_cfg = cfg.get("async_reflection") or {}
    agent.async_reflection_enabled = bool(agent.async_reflection_cfg.get("enabled", False))
    agent.micro_planning_cfg = cfg.get("micro_planning") or {}
    agent.micro_planning_enabled = bool(agent.micro_planning_cfg.get("enabled", False))
    agent.micro_plan_mode = str(agent.micro_planning_cfg.get("mode", "tags")).strip().lower()
    if agent.micro_plan_mode not in {"tags", "anchor"}:
        agent.micro_plan_mode = "tags"
    agent.micro_plan_start = str(agent.micro_planning_cfg.get("start_tag", "[PLAN]"))
    agent.micro_plan_end = str(agent.micro_planning_cfg.get("end_tag", "[/PLAN]"))
    agent.micro_plan_anchor_prefix = str(agent.micro_planning_cfg.get("anchor_plan", "PLAN:"))
    agent.micro_plan_anchor_reply = str(agent.micro_planning_cfg.get("anchor_reply", "SAY:"))
    agent.micro_plan_prefill_enabled = bool(agent.micro_planning_cfg.get("prefill_enabled", False))
    agent._micro_plan_metrics = {
        "filtered_stream_chars": 0,
        "filtered_final_chars": 0,
        "unclosed_blocks": 0,
        "leak_detected": 0,
    }
    dual = bool(getattr(agent, "llm_dual", False)) or (
        len({conn_talk.provider, conn_brain.provider, conn_memory.provider}) > 1
    )
    logger.info(
        "Бэкенд LLM: talk_provider=%s%s | talk=%s@%s brain=%s@%s memory=%s@%s | "
        "timeout talk=%ss retries=%s | context=provider-max",
        conn_talk.provider,
        " (dual)" if dual else "",
        talk_model,
        conn_talk.provider,
        brain_model,
        conn_brain.provider,
        memory_model,
        conn_memory.provider,
        talk_timeout,
        talk_retries,
    )
    logger.info(
        "LLM token budgets | reply=%s | brain=%s | lyrics_cap=%s | vision=%s | memory/reflection=%s | async_reflection_note_max=%s",
        agent.reply_max_tokens,
        agent.brain_max_tokens,
        getattr(agent, "lyrics_reply_max_tokens", 0),
        agent.vision_max_tokens,
        agent.reflection_max_tokens,
        int(agent.async_reflection_cfg.get("max_tokens", 500)),
    )
    logger.info("LLM vision_model id (resolved)=%s @%s", vision_model_id, conn_vision.provider)
    if agent.async_reflection_enabled:
        logger.info(
            "Async reflection включен | memory_model=%s (поведение из async_reflection.*)",
            memory_model,
        )

    agent.llm_with_tools = agent.llm_brain
    agent.llm_capabilities = dict(conn_talk.capabilities)

    from core.llm.profile import merged_vision_pipeline

    vis = merged_vision_pipeline(agent.config)
    agent.llm_vision = None
    if vis.get("enabled"):
        if vis.get("use_brain_model_for_vision"):
            agent.llm_vision = agent.llm_brain
            logger.info(
                "Зрение: unified brain — нативный мультимодальный ввод (%s@%s).",
                brain_model,
                conn_brain.provider,
            )
        else:
            vmodel = str(vision_model_id).strip()
            hdr_vision = dict(conn_vision.default_headers)
            hdr_vision["X-Title"] = "Neyra AI Vision"
            agent.llm_vision = ChatOpenAI(
                base_url=conn_vision.base_url,
                api_key=conn_vision.api_key,
                model=vmodel,
                temperature=float(cfg.get("vision_temperature", cfg.get("temperature", 0.75))),
                max_tokens=agent.vision_max_tokens,
                streaming=True,
                timeout=float(cfg.get("vision_timeout_seconds", 180)),
                model_kwargs={"extra_body": extra_body} if extra_body else {},
                default_headers=hdr_vision,
            )
            logger.info("Зрение: VL-модель (%s) — %s", conn_vision.provider, vmodel)
