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
            return str(model)[:256]
    md2 = getattr(payload, "metadata", None) or {}
    if isinstance(md2, dict):
        model = md2.get("model_name") or md2.get("model")
        if model:
            return str(model)[:256]
    return None


def log_model_route(agent: Any, used_model: Optional[str], *, lane: str = "talk") -> None:
    logger.info("LLM route | lane=%s | reported_model=%s", lane, used_model or "not_reported")


async def astream_text_with_fallback(
    agent: Any, messages: list[Any], *, llm: Any = None, retry_layer: str | None = None
) -> AsyncIterator[Any]:
    """Streaming call with first-token timeout guard and one retry on the same model."""
    from core.llm.message_content import message_content_to_text

    model = llm or agent.llm_talk
    first_timeout = max(0.1, float(getattr(agent, "primary_first_token_timeout", 8.0)))
    attempts = 2
    last_err: Optional[Exception] = None
    from .model_trace import ACTIVE_TRACE
    trace = ACTIVE_TRACE.get()
    control = getattr(trace, "stream_control", None)

    def public_emitted(raw_emitted):
        return bool(control["public_emitted"]()) if control else raw_emitted

    def reset_retry():
        if control:
            control["on_retry"]()

    layer = retry_layer
    for attempt in range(1, attempts + 1):
        from .model_trace import begin_call, end_call, mark_first_meaningful_token, mark_first_text_delta, observe_payload
        call = begin_call(agent, "talk", "stream_reply", images=any(isinstance(getattr(m, "content", None), list) for m in messages), model=model, retry_layer=layer)
        started = time.monotonic()
        stream = model.astream(messages)
        it = stream.__aiter__()
        emitted = False
        try:
            deadline = time.monotonic() + first_timeout
            while True:
                first_chunk = await asyncio.wait_for(it.__anext__(), timeout=max(0, deadline - time.monotonic()))
                observe_payload(call, first_chunk)
                first_token = message_content_to_text(getattr(first_chunk, "content", ""))
                if first_token:
                    mark_first_text_delta(call)
                    break
            if first_token:
                if not control:
                    mark_first_meaningful_token(call)
                route = "primary" if attempt == 1 else "primary_retry"
                logger.info(
                    "LLM first token | route=%s | delay=%.3fs",
                    route,
                    time.monotonic() - started,
                )
            emitted = True
            yield first_chunk
            async for ch in it:
                observe_payload(call, ch)
                if message_content_to_text(getattr(ch, "content", "")):
                    mark_first_text_delta(call)
                    if not control:
                        mark_first_meaningful_token(call)
                yield ch
            end_call(call)
            return
        except asyncio.TimeoutError as e:
            end_call(call, status="failed", error_class=e)
            if public_emitted(emitted):
                raise
            if emitted:
                last_err = e
                if attempt >= attempts:
                    raise
                layer = "stream_timeout"
                reset_retry()
                continue
            last_err = TimeoutError(
                f"LLM first-token timeout after {first_timeout:.1f}s "
                f"(attempt {attempt}/{attempts})"
            )
            last_err.__cause__ = e
            logger.warning(
                "LLM first-token timeout | attempt=%s/%s | timeout=%.1fs",
                attempt,
                attempts,
                first_timeout,
            )
            if attempt < attempts:
                layer = "stream_timeout"
                reset_retry()
            continue
        except StopAsyncIteration:
            end_call(call)
            return
        except Exception as e:
            end_call(call, status="failed", error_class=e)
            last_err = e
            if public_emitted(emitted) or attempt >= attempts:
                raise
            logger.warning("LLM stream attempt failed, retrying same model: %s", e)
            layer = "stream_error"
            reset_retry()
            continue
        finally:
            if call is not None and call["status"] == "running":
                end_call(call, status="cancelled", error_class="CancelledError")
            close = getattr(it, "aclose", None)
            if close is not None:
                await close()

    if last_err:
        raise last_err
