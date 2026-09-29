"""
LLM connection helpers: OpenAI-compatible profiles, retries, OpenRouter usage.

Canonical imports: ``from core.llm.profile import …``, ``from core.llm.retry import …``.
This package ``__init__`` exposes names lazily so light shims (retry/profile) do not
pull ``httpx`` / OpenRouter client at import time.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "AIHOPE_API_BASE",
    "AIHOPE_BALANCE_URL",
    "OpenAICompatibleConnection",
    "aihope_list_models",
    "aihope_post",
    "ainvoke_with_rate_limit_backoff",
    "expand_role_nested",
    "fetch_aihope_token_usage",
    "fetch_openrouter_key_usage",
    "is_local_openai_compatible_provider",
    "is_retryable_llm_error",
    "merge_llm_tuning_options",
    "merged_vision_pipeline",
    "connection_for_provider",
    "iter_unique_provider_connections",
    "resolve_openai_compatible_connection",
    "resolve_role_provider",
    "resolved_brain_model",
    "resolved_brain_model_deep",
    "resolved_memory_model",
    "resolved_talk_model",
    "resolved_vision_model_id",
    "LLM_ROLE_ORDER",
]

_PROFILE_NAMES = frozenset(
    {
        "OpenAICompatibleConnection",
        "LLM_ROLE_ORDER",
        "connection_for_provider",
        "expand_role_nested",
        "is_local_openai_compatible_provider",
        "iter_unique_provider_connections",
        "merge_llm_tuning_options",
        "merged_vision_pipeline",
        "resolve_openai_compatible_connection",
        "resolve_role_provider",
        "resolved_brain_model",
        "resolved_brain_model_deep",
        "resolved_memory_model",
        "resolved_talk_model",
        "resolved_vision_model_id",
    }
)
_RETRY_NAMES = frozenset({"ainvoke_with_rate_limit_backoff", "is_retryable_llm_error"})
_BALANCE_NAMES = frozenset({"fetch_openrouter_key_usage"})
_AIHOPE_NAMES = frozenset(
    {
        "AIHOPE_API_BASE",
        "AIHOPE_BALANCE_URL",
        "aihope_list_models",
        "aihope_post",
        "fetch_aihope_token_usage",
    }
)


def __getattr__(name: str) -> Any:
    if name in _PROFILE_NAMES:
        from core.llm import profile as mod

        return getattr(mod, name)
    if name in _RETRY_NAMES:
        from core.llm import retry as mod

        return getattr(mod, name)
    if name in _BALANCE_NAMES:
        from core.llm import openrouter_balance as mod

        return getattr(mod, name)
    if name in _AIHOPE_NAMES:
        from core.llm import aihope as mod

        return getattr(mod, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
