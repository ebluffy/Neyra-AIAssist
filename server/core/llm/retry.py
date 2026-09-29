"""
Повторные вызовы memory_model при HTTP 429 / таймаутах (экспоненциальная задержка).
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
    """Вызывает llm.ainvoke с повторами при rate limit / таймауте."""
    last_err: BaseException | None = None
    attempts = max(1, int(max_attempts))
    for attempt in range(1, attempts + 1):
        try:
            if hasattr(llm, "ainvoke"):
                return await llm.ainvoke(messages)
            return await asyncio.to_thread(llm.invoke, messages)
        except Exception as e:
            last_err = e
            if attempt >= attempts or not is_retryable_llm_error(e):
                raise
            delay = min(max_delay_seconds, base_delay_seconds * (2 ** (attempt - 1)))
            logger.warning(
                "[WARNING] %s rate-limited. Retrying in %.1f seconds... (attempt %s/%s): %s",
                lane,
                delay,
                attempt,
                attempts,
                e,
            )
            await asyncio.sleep(delay)
    if last_err is not None:
        raise last_err
    raise RuntimeError("ainvoke_with_rate_limit_backoff: no result")
