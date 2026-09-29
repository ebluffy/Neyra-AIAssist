"""LLM talk helpers: model route logging and streaming with first-token retry."""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, AsyncIterator, Optional

logger = logging.getLogger("neyra.agent.llm_stream")


def extract_model_name(payload: Any) -> Optional[str]:
    md = getattr(payload, "response_metadata", None) or {}
    if isinstance(md, dict):
        model = md.get("model_name") or md.get("model")
        if model:
            return str(model)
    md2 = getattr(payload, "metadata", None) or {}
    if isinstance(md2, dict):
        model = md2.get("model_name") or md2.get("model")
        if model:
            return str(model)
    return None


def log_model_route(agent: Any, used_model: Optional[str], *, lane: str = "talk") -> None:
    if not used_model:
        return
    primary = str(getattr(agent, "llm_primary_model", "") or "")
    fallback = str(getattr(agent, "llm_fallback_model", "") or "")
    route = "primary"
    if fallback and fallback in used_model:
        route = "fallback"
    logger.info("LLM route | lane=%s | route=%s | model=%s", lane, route, used_model)


async def astream_text_with_fallback(
    agent: Any, messages: list[Any], *, llm: Any = None
) -> AsyncIterator[Any]:
    """Streaming call with first-token timeout guard and one retry on the same model."""
    model = llm or agent.llm_talk
    first_timeout = max(0.1, float(getattr(agent, "primary_first_token_timeout", 8.0)))
    attempts = 2
    last_err: Optional[Exception] = None

    for attempt in range(1, attempts + 1):
        started = time.monotonic()
        stream = model.astream(messages)
        it = stream.__aiter__()
        try:
            first_chunk = await asyncio.wait_for(it.__anext__(), timeout=first_timeout)
            first_token = first_chunk.content if hasattr(first_chunk, "content") else str(first_chunk)
            if first_token:
                route = "primary" if attempt == 1 else "primary_retry"
                logger.info(
                    "LLM first token | route=%s | delay=%.3fs",
                    route,
                    time.monotonic() - started,
                )
            yield first_chunk
            async for ch in it:
                yield ch
            return
        except asyncio.TimeoutError as e:
            last_err = e
            logger.warning(
                "LLM first-token timeout | attempt=%s/%s | timeout=%.1fs",
                attempt,
                attempts,
                first_timeout,
            )
            continue
        except StopAsyncIteration:
            return
        except Exception as e:
            last_err = e
            if attempt >= attempts:
                raise
            logger.warning("LLM stream attempt failed, retrying same model: %s", e)
            continue

    if last_err:
        raise last_err
