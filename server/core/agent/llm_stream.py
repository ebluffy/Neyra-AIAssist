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


def talk_turn_budget_seconds(agent: Any) -> float:
    """Whole talk-stream budget. Retries share it; the default is the existing request timeout."""
    cfg = ((getattr(agent, "config", None) or {}).get("llm") or {}).get("talk_model") or {}
    explicit = cfg.get("turn_timeout_seconds")
    if explicit is not None:
        return max(0.1, float(explicit))
    if cfg.get("timeout_seconds") is not None:
        return max(0.1, float(cfg["timeout_seconds"]))
    return max(0.1, float(getattr(agent, "primary_first_token_timeout", 8.0)) * 2)


def chunk_has_reasoning(chunk: Any) -> bool:
    extra = getattr(chunk, "additional_kwargs", None) or {}
    if extra.get("neyra_progress") == "reasoning":
        return True
    if extra.get("reasoning_content") or extra.get("reasoning"):
        return True
    metadata = getattr(chunk, "response_metadata", None) or {}
    if isinstance(metadata, dict) and (metadata.get("reasoning_content") or metadata.get("reasoning")):
        return True
    content = getattr(chunk, "content", None)
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and str(part.get("type") or "").lower().startswith("reasoning"):
                return True
    return False


def visible_chunk_text(chunk: Any) -> str:
    from core.llm.message_content import message_content_to_text

    content = getattr(chunk, "content", None)
    if isinstance(content, list):
        content = [part for part in content
                   if not (isinstance(part, dict) and str(part.get("type") or "").lower().startswith("reasoning"))]
    return message_content_to_text(content)


async def astream_text_with_fallback(
    agent: Any, messages: list[Any], *, llm: Any = None, retry_layer: str | None = None
) -> AsyncIterator[Any]:
    """Streaming call with first-token timeout guard and one retry on the same model."""
    model = llm or agent.llm_talk
    first_timeout = max(0.1, float(getattr(agent, "primary_first_token_timeout", 8.0)))
    attempts = 2
    last_err: Optional[Exception] = None
    budget_deadline = time.monotonic() + talk_turn_budget_seconds(agent)
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
        remaining = budget_deadline - time.monotonic()
        if remaining < 0.05:
            last_err = TimeoutError("LLM turn budget exhausted")
            break
        from .model_trace import begin_call, end_call, mark_first_meaningful_token, mark_first_reasoning, mark_first_text_delta, observe_payload
        call = begin_call(agent, "talk", "stream_reply", images=any(isinstance(getattr(m, "content", None), list) for m in messages), model=model, retry_layer=layer)
        started = time.monotonic()
        stream = model.astream(messages)
        it = stream.__aiter__()
        emitted = False
        try:
            deadline = min(time.monotonic() + first_timeout, budget_deadline)
            while True:
                wait = min(deadline, budget_deadline) - time.monotonic()
                if wait <= 0:
                    raise asyncio.TimeoutError()
                first_chunk = await asyncio.wait_for(it.__anext__(), timeout=wait)
                observe_payload(call, first_chunk)
                if chunk_has_reasoning(first_chunk) and not visible_chunk_text(first_chunk):
                    mark_first_reasoning(call)
                    deadline = min(time.monotonic() + first_timeout, budget_deadline)
                    continue
                first_token = visible_chunk_text(first_chunk)
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
                if chunk_has_reasoning(ch) and not visible_chunk_text(ch):
                    mark_first_reasoning(call)
                    continue
                if visible_chunk_text(ch):
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
                if attempt >= attempts or budget_deadline - time.monotonic() < 0.05:
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
            if attempt < attempts and budget_deadline - time.monotonic() >= 0.05:
                layer = "stream_timeout"
                reset_retry()
                continue
            break
        except StopAsyncIteration:
            end_call(call)
            return
        except Exception as e:
            end_call(call, status="failed", error_class=e)
            last_err = e
            if public_emitted(emitted) or attempt >= attempts:
                raise
            logger.warning("LLM stream attempt failed, retrying same model: %s", type(e).__name__)
            if budget_deadline - time.monotonic() < 0.05:
                break
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
