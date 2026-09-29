"""
LLM connection helpers: OpenAI-compatible profiles, retries, OpenRouter usage.

Canonical imports: ``from core.llm.profile import …``, ``from core.llm.retry import …``.
This package ``__init__`` exposes names lazily so light shims (retry/profile) do not
pull ``httpx`` / OpenRouter client at import time.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "OpenAICompatibleConnection",
    "ainvoke_with_rate_limit_backoff",
    "expand_openrouter_nested",
    "fetch_openrouter_key_usage",
    "is_local_openai_compatible_provider",
    "is_retryable_llm_error",
    "merge_llm_tuning_options",
    "merged_vision_pipeline",
    "resolve_openai_compatible_connection",
    "resolved_brain_model",
    "resolved_brain_model_deep",
    "resolved_memory_model",
    "resolved_primary_model",
    "resolved_talk_model",
    "resolved_vision_model_id",
]

_PROFILE_NAMES = frozenset(
    {
        "OpenAICompatibleConnection",
        "expand_openrouter_nested",
        "is_local_openai_compatible_provider",
        "merge_llm_tuning_options",
        "merged_vision_pipeline",
        "resolve_openai_compatible_connection",
        "resolved_brain_model",
        "resolved_brain_model_deep",
        "resolved_memory_model",
        "resolved_primary_model",
        "resolved_talk_model",
        "resolved_vision_model_id",
    }
)
_RETRY_NAMES = frozenset({"ainvoke_with_rate_limit_backoff", "is_retryable_llm_error"})
_BALANCE_NAMES = frozenset({"fetch_openrouter_key_usage"})


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
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
