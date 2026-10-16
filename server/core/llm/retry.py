"""
    Retry memory-model calls after HTTP 429 or timeouts with exponential backoff.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

logger = logging.getLogger("neyra.llm_retry")

_RATE_LIMIT_RE = re.compile(r"429|rate[\s_-]?limit|too many requests", re.I)


def is_retryable_llm_error(exc: BaseException) -> bool:
    msg = str(exc).lower()
    if _RATE_LIMIT_RE.search(msg):
        return True
    if "timeout" in msg or "timed out" in msg:
        return True
    status = getattr(exc, "status_code", None)
    if status is None:
        resp = getattr(exc, "response", None)
        status = getattr(resp, "status_code", None) if resp is not None else None
    if status == 429:
        return True
    return False


async def ainvoke_with_rate_limit_backoff(
    llm: Any,
    messages: list[Any],
    *,
    lane: str = "memory_model",
    max_attempts: int = 5,
    base_delay_seconds: float = 2.0,
    max_delay_seconds: float = 60.0,
) -> Any:
    """Invoke the model with retries for rate limits and timeouts."""
    last_err: BaseException | None = None
    attempts = max(1, int(max_attempts))
    for attempt in range(1, attempts + 1):
        try:
            from core.agent.model_trace import invoke
            if hasattr(llm, "ainvoke"):
                return await invoke(None, llm, messages, lane="memory", purpose=lane)
            async def sync_invoke(messages):
                return await asyncio.to_thread(llm.invoke, messages)
            return await invoke(None, llm, messages, lane="memory", purpose=lane, invoker=lambda messages, **kwargs: sync_invoke(messages))
        except Exception as e:
            last_err = e
            if attempt >= attempts or not is_retryable_llm_error(e):
                raise
            delay = min(max_delay_seconds, base_delay_seconds * (2 ** (attempt - 1)))
            logger.warning(
                "[WARNING] %s is retryable. Retrying in %.1f seconds (attempt %s/%s): %s",
                lane,
                delay,
                attempt,
                attempts,
                type(e).__name__,
            )
            await asyncio.sleep(delay)
    if last_err is not None:
        raise last_err
    raise RuntimeError("ainvoke_with_rate_limit_backoff: no result")
