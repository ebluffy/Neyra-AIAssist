"""Per-turn LLM evidence and bounded, content-free operational activity."""

from __future__ import annotations

import copy
import asyncio
import logging
import re
import threading
import time
import uuid
from functools import wraps
from collections import deque
from contextvars import ContextVar
from dataclasses import dataclass, field
from datetime import datetime, timezone

from core.runtime.event_bus import CoreEvent

logger = logging.getLogger("neyra.model_trace")
_CLASS_NAME = re.compile(r"[^A-Za-z0-9_]")
_EVENT_TYPE = re.compile(r"[^A-Za-z0-9._:-]")
RETRY_LAYERS = {"stream_timeout", "stream_error", "responses_history", "empty_reply", "context_overflow"}
TRACE_ROLE = "model_trace"


@dataclass
class TurnTrace:
    user_id: str | None
    channel_id: str | None
    config: dict = field(default_factory=dict)
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    started_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    calls: list = field(default_factory=list)
    failed: bool = False
    closed: bool = False
    conversation_mode: str = field(init=False)
    ended_at: str | None = None
    duration_ms: float | None = None
    tasks: list = field(default_factory=list)
    kind: str = "turn"
    parent_turn_id: str | None = None
    memory_owner_id: str | None = None
    affect_generations: dict | None = None
    talk_session: object | None = field(default=None, repr=False)
    conversation_gate: object | None = field(default=None, repr=False)
    conversation_scope: object | None = field(default=None, repr=False)
    stream_control: dict | None = field(default=None, repr=False)
    queue_wait_ms: float | None = None
    error_class: str | None = None

    def __post_init__(self):
        self.conversation_mode = (self.config.get("agent") or {}).get("conversation_mode", "default")
        self._started_monotonic = time.monotonic()

    def report(self, status=None):
        return copy.deepcopy({
            "turn_id": self.id, "timestamp": self.started_at,
            "status": status or ("failed" if self.failed else "completed"),
            "error_class": self.error_class,
            "queue_wait_ms": self.queue_wait_ms,
            "calls": [_public_call(call) for call in self.calls],
            "tasks": self.tasks, "without_llm": not self.calls,
            "ended_at": self.ended_at, "duration_ms": self.duration_ms,
            "kind": self.kind, "parent_turn_id": self.parent_turn_id,
        })


ACTIVE_TRACE: ContextVar[TurnTrace | None] = ContextVar("neyra_model_trace", default=None)
MEMORY_JOB: ContextVar[tuple | None] = ContextVar("neyra_memory_job", default=None)


def turn_conversation_mode(config):
    trace = ACTIVE_TRACE.get()
    return trace.conversation_mode if trace and not trace.closed else (config.get("agent") or {}).get("conversation_mode", "default")


class ModelActivity:
    def __init__(self):
        self._items = deque(maxlen=200)
        self._jobs = deque(maxlen=200)
        self._lock = threading.Lock()

    def append(self, trace, report):
        with self._lock:
            target = self._jobs if report.get("kind") == "background" else self._items
            target.append((trace.user_id, trace.channel_id, copy.deepcopy(report)))

    def recent(self, limit=20):
        with self._lock:
            rows = sorted([*reversed(self._items), *reversed(self._jobs)], key=lambda row: row[2].get("timestamp", ""), reverse=True)
            return [copy.deepcopy(row[2]) for row in rows[:limit]]

    def for_owner(self, user_id, channel_id):
        with self._lock:
            for uid, cid, report in reversed(self._items):
                if uid == user_id and cid == channel_id and report.get("kind", "turn") == "turn":
                    return copy.deepcopy(report)
        return None


def activity_for(agent):
    # Initialized before calls for real agents; laziness supports lightweight test agents.
    activity = getattr(agent, "model_activity", None)
    if not isinstance(activity, ModelActivity):
        agent.model_activity = ModelActivity()
    return agent.model_activity


def snapshot():
    trace = ACTIVE_TRACE.get()
    return trace.report() if trace and not trace.closed else None


def class_name(exc) -> str:
    raw = exc if isinstance(exc, str) else type(exc).__name__
    cleaned = _CLASS_NAME.sub("", str(raw))[:64]
    return cleaned or "Error"


def _event_type(value):
    if not isinstance(value, str):
        return None
    cleaned = _EVENT_TYPE.sub("", value)[:64]
    return cleaned or None


def _retry_layer(value):
    return value if value in RETRY_LAYERS else None


def _elapsed(call):
    return round((time.monotonic() - call["_started_monotonic"]) * 1000, 3)


def _public_call(call):
    return {key: value for key, value in call.items() if not str(key).startswith("_")}


def running_call():
    trace = ACTIVE_TRACE.get()
    if trace is None or trace.closed:
        return None
    for call in reversed(trace.calls):
        if call.get("status") == "running":
            return call
    return None


def note_turn_error(exc):
    trace = ACTIVE_TRACE.get()
    if trace is None or trace.closed or trace.error_class:
        return
    trace.error_class = class_name(exc)


class _SdkRetryFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if isinstance(record.msg, str) and record.msg.startswith("Retrying request"):
                call = running_call()
                if call is not None:
                    call["sdk_retries"] = int(call.get("sdk_retries") or 0) + 1
        except Exception:
            pass
        return True


def _install_sdk_retry_notes():
    filt = _SdkRetryFilter()
    for name in ("openai._base_client", "openai"):
        log = logging.getLogger(name)
        if not any(isinstance(item, _SdkRetryFilter) for item in log.filters):
            log.addFilter(filt)


def _terminal_error_class(trace, status):
    if trace.error_class:
        return trace.error_class
    if status not in ("failed", "cancelled"):
        return None
    for call in reversed(trace.calls):
        if call.get("error_class"):
            return call["error_class"]
    return "CancelledError" if status == "cancelled" else None


def _persist_turn(agent, trace, report):
    if trace.kind != "turn":
        return
    hub = getattr(agent, "memory_hub", None)
    if hub is None:
        return
    try:
        updated = hub.sqlite.update_turn_trace(trace.id, report)
        if updated or report.get("status") not in ("failed", "cancelled"):
            return
        hub.sqlite.append_chat_rows([{
            "role": TRACE_ROLE,
            "text": "",
            "user_id": trace.memory_owner_id,
            "channel_id": trace.channel_id,
            "source": TRACE_ROLE,
            "turn_id": trace.id,
            "meta": {"model_trace": report},
        }])
    except Exception:
        logger.exception("Failed to persist model evidence")


def finish(agent, trace, status=None):
    if trace.closed:
        return trace.report(status)
    final = status or ("failed" if trace.failed else "completed")
    for call in trace.calls:
        if call["status"] == "running":
            end_call(call, status="cancelled" if final == "cancelled" else "failed",
                     error_class="CancelledError" if final == "cancelled" else None)
    for task in trace.tasks:
        if task["status"] == "running":
            end_task(task, status="cancelled" if final == "cancelled" else "failed")
    trace.error_class = _terminal_error_class(trace, final)
    trace.closed = True
    trace.ended_at = datetime.now(timezone.utc).isoformat()
    trace.duration_ms = round((time.monotonic() - getattr(trace, "_started_monotonic", time.monotonic())) * 1000, 3)
    report = trace.report(final)
    _persist_turn(agent, trace, report)
    activity_for(agent).append(trace, report)
    agent.event_bus.publish(CoreEvent("llm.turn.completed", "core.agent", report))
    return report


def begin_call(agent, lane, purpose, attempt=None, images=False, model=None, retry_layer=None):
    _install_sdk_retry_notes()
    trace = ACTIVE_TRACE.get()
    if trace is None or trace.closed:
        return None
    config = agent.config if agent is not None else trace.config
    role = ((config.get("llm") or {}).get(f"{lane}_model") or {})
    actual_model = model
    for _ in range(3):
        bound = getattr(actual_model, "bound", None)
        if bound is None:
            break
        actual_model = bound
    requested_name = getattr(actual_model, "model_name", None)
    if not isinstance(requested_name, str):
        requested_name = role.get("model")
    effective_lane = lane
    if agent is not None and lane == "vision" and model is getattr(agent, "llm_brain", None):
        effective_lane = "brain"
    connection = getattr(agent, f"_llm_conn_{effective_lane}", None) if agent is not None else None
    provider = getattr(connection, "provider", None)
    if not isinstance(provider, str):
        provider = ((config.get("llm") or {}).get(f"{effective_lane}_model") or {}).get("provider")
    if attempt is None:
        attempt = 1 + sum(c["lane"] == lane and c["purpose"] == purpose for c in trace.calls)
    call = {
        "call_id": str(uuid.uuid4()),
        "lane": lane, "purpose": purpose, "attempt": attempt,
        "provider": str(provider)[:120] if provider else None,
        "configured_model": str(requested_name)[:256] if requested_name else None,
        "reported_model": None, "provider_request_id": None, "provider_response_id": None,
        "has_images": bool(images), "status": "running",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "duration_ms": None, "first_meaningful_token_at": None,
        "first_meaningful_token_ms": None,
        "headers_ms": None, "http_status": None,
        "first_event_ms": None, "first_event_type": None,
        "first_text_delta_ms": None, "first_reasoning_ms": None,
        "terminal_event": None, "incomplete_reason": None, "truncated": False,
        "retry_layer": _retry_layer(retry_layer), "sdk_retries": 0,
        "error_class": None,
        "usage": None,
        "provider_usage": None, "cost_estimate": None, "actual_billing": None,
    }
    call["_started_monotonic"] = time.monotonic()
    trace.calls.append(call)
    return call


def _metadata(payload):
    out = []
    for name in ("response_metadata", "metadata"):
        value = getattr(payload, name, None)
        if isinstance(value, dict):
            out.append(value)
    return out


def _extract_provider_details(payload):
    provider_request_id = None
    usage = None
    for metadata in _metadata(payload):
        if provider_request_id is None:
            for key in ("request_id", "requestId", "provider_request_id"):
                if metadata.get(key) is not None:
                    provider_request_id = str(metadata[key])[:256]
                    break
            headers = metadata.get("headers") or metadata.get("response_headers")
            if provider_request_id is None and isinstance(headers, dict):
                headers = {str(k).lower(): v for k, v in headers.items()}
                value = headers.get("x-request-id") or headers.get("request-id")
                if value:
                    provider_request_id = str(value)[:256]
        candidate = metadata.get("usage") or metadata.get("token_usage") or metadata.get("usage_metadata")
        if isinstance(candidate, dict) and usage is None:
            usage = copy.deepcopy(candidate)
    direct_usage = getattr(payload, "usage_metadata", None)
    if isinstance(direct_usage, dict) and usage is None:
        usage = copy.deepcopy(direct_usage)
    if usage is not None:
        allowed = {"input_tokens", "output_tokens", "prompt_tokens", "completion_tokens", "total_tokens",
                   "input_token_details", "output_token_details", "input_tokens_details", "output_tokens_details", "prompt_tokens_details", "completion_tokens_details",
                   "cache_read_tokens", "cache_read_input_tokens", "cache_creation_tokens", "cache_creation_input_tokens"}
        detail_keys = {"cache_read", "cache_creation", "cached_tokens", "audio", "audio_tokens", "text", "text_tokens", "reasoning", "reasoning_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"}
        def counts(value, depth=0):
            if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                return value
            if isinstance(value, dict) and depth < 2:
                return {str(k)[:80]: result for k, v in value.items()
                        if k in (detail_keys if depth > 0 else allowed) and (result := counts(v, depth + 1)) is not None}
            return None
        usage = counts(usage)
    return provider_request_id, usage


def _mark_once(call, key):
    if call is None or call.get(key) is not None or "_started_monotonic" not in call:
        return False
    if call.get("status") != "running":
        return False
    call[key] = _elapsed(call)
    return True


def mark_response_headers(call, status):
    if not _mark_once(call, "headers_ms"):
        return
    if isinstance(status, int) and not isinstance(status, bool):
        call["http_status"] = status


def mark_first_event(call, event_type):
    if not _mark_once(call, "first_event_ms"):
        return
    call["first_event_type"] = _event_type(event_type)


def mark_first_text_delta(call):
    _mark_once(call, "first_text_delta_ms")


def mark_first_reasoning(call):
    _mark_once(call, "first_reasoning_ms")


def note_terminal(call, event, reason=None, truncated=False):
    if call is None or call.get("status") != "running":
        return
    event_name = _event_type(event)
    reason_name = _event_type(reason)
    if event_name:
        call["terminal_event"] = event_name
    if reason_name:
        call["incomplete_reason"] = reason_name
    if truncated:
        call["truncated"] = True
    logger.info(
        "LLM terminal | event=%s reason=%s truncated=%s",
        call.get("terminal_event"), call.get("incomplete_reason"), bool(call.get("truncated")),
    )


def mark_first_meaningful_token(call):
    if call is None or call.get("first_meaningful_token_at") is not None or "_started_monotonic" not in call:
        return
    call["first_meaningful_token_at"] = datetime.now(timezone.utc).isoformat()
    call["first_meaningful_token_ms"] = _elapsed(call)


def end_call(call, payload=None, status="completed", error_class=None):
    if call is None or call.get("status") != "running":
        return
    observe_payload(call, payload)
    if call.get("first_meaningful_token_at") is None and payload is not None:
        mark_first_meaningful_token(call)
    if error_class and not call.get("error_class"):
        call["error_class"] = class_name(error_class)
    call["status"] = status
    call["ended_at"] = datetime.now(timezone.utc).isoformat()
    call["duration_ms"] = round((time.monotonic() - call["_started_monotonic"]) * 1000, 3)
    call.pop("_started_monotonic", None)
    logger.info(
        "LLM call | lane=%s purpose=%s attempt=%s provider=%s configured_model=%s reported_model=%s status=%s error_class=%s retry_layer=%s sdk_retries=%s headers_ms=%s http_status=%s first_event_ms=%s first_event_type=%s first_text_delta_ms=%s first_meaningful_token_ms=%s duration_ms=%s",
        call["lane"], call["purpose"], call["attempt"], call["provider"], call["configured_model"], call["reported_model"], status,
        call.get("error_class"), call.get("retry_layer"), call.get("sdk_retries"), call.get("headers_ms"), call.get("http_status"),
        call.get("first_event_ms"), call.get("first_event_type"), call.get("first_text_delta_ms"), call.get("first_meaningful_token_ms"), call.get("duration_ms"),
    )


def observe_payload(call, payload):
    if call is None or payload is None:
        return
    from .llm_stream import extract_model_name
    name = extract_model_name(payload)
    call["reported_model"] = name or call["reported_model"]
    for metadata in _metadata(payload):
        if metadata.get("id"):
            call["provider_response_id"] = str(metadata["id"])[:256]
    request_id, usage = _extract_provider_details(payload)
    if request_id is not None:
        call["provider_request_id"] = request_id
    if usage is not None:
        usage = {**(call.get("provider_usage") or {}), **usage}
        call["provider_usage"] = usage
        details = usage.get("input_token_details") or usage.get("input_tokens_details") or usage.get("prompt_tokens_details") or {}
        output_details = usage.get("output_token_details") or usage.get("output_tokens_details") or {}
        if not isinstance(output_details, dict):
            output_details = {}
        call["usage"] = {
            "input_tokens": usage.get("input_tokens", usage.get("prompt_tokens")),
            "output_tokens": usage.get("output_tokens", usage.get("completion_tokens")),
            "cache_read_tokens": usage.get("cache_read_tokens", usage.get("cache_read_input_tokens", details.get("cache_read", details.get("cached_tokens")))),
            "cache_creation_tokens": usage.get("cache_creation_tokens", usage.get("cache_creation_input_tokens", details.get("cache_creation"))),
            "reasoning_tokens": usage.get("reasoning_tokens", output_details.get("reasoning_tokens", output_details.get("reasoning"))),
        }
        call["usage"] = {k: v for k, v in call["usage"].items() if v is not None}


def spawn_background(agent, purpose, factory):
    """Give each job a separate report; never mutate a completed parent turn."""
    parent = ACTIVE_TRACE.get()
    hub = getattr(agent, "memory_hub", None)
    with getattr(hub, "_write_lock", threading.RLock()):
        parent_job = MEMORY_JOB.get()
        generations = dict(parent_job[1] if parent_job and parent_job[0] is hub else getattr(hub, "_generations", {}))
    child = TurnTrace(parent.user_id if parent else None, parent.channel_id if parent else None,
                      getattr(agent, "config", {}), kind="background", parent_turn_id=parent.id if parent else None,
                      memory_owner_id=parent.memory_owner_id if parent else None)

    async def run():
        token = ACTIVE_TRACE.set(child)
        guard = MEMORY_JOB.set((hub, generations))
        task = begin_task(agent, purpose)
        status = "completed"
        try:
            return await factory()
        except asyncio.CancelledError:
            status = "cancelled"
            raise
        except Exception as exc:
            status = "failed"
            logger.error("Background operation failed | purpose=%s error_type=%s", purpose, type(exc).__name__)
        finally:
            if status == "completed" and child.calls and child.calls[-1]["status"] == "failed":
                status = "failed"
            end_task(task, status)
            finish(agent, child, status)
            MEMORY_JOB.reset(guard)
            ACTIVE_TRACE.reset(token)
    pending = getattr(agent, "_background_jobs", None)
    if pending is None:
        pending = agent._background_jobs = set()
    job = asyncio.create_task(run())
    pending.add(job)
    def completed(job):
        pending.discard(job)
        if not child.closed:
            finish(agent, child, "cancelled" if job.cancelled() else "failed")
    job.add_done_callback(completed)
    return job


def traced_background(purpose):
    def decorate(function):
        @wraps(function)
        async def run(self, *args, **kwargs):
            agent = getattr(self, "agent", None)
            if agent is None:
                return await function(self, *args, **kwargs)
            return await spawn_background(agent, purpose, lambda: function(self, *args, **kwargs))
        return run
    return decorate


async def invoke(agent, llm, messages, *, lane, purpose, images=False, invoker=None, retry_layer=None):
    from .responses_talk import ResponsesRetryable
    layer = _retry_layer(retry_layer) or ("empty_reply" if purpose == "empty_reply_retry" else None)
    for attempt in range(2):
        call = begin_call(agent, lane, purpose, images=images, model=llm, retry_layer=layer)
        try:
            result = await invoker(messages, llm=llm) if invoker else await llm.ainvoke(messages)
        except BaseException as exc:
            end_call(call, status="cancelled" if isinstance(exc, asyncio.CancelledError) else "failed", error_class=exc)
            if isinstance(exc, ResponsesRetryable) and attempt == 0:
                layer = "responses_history"
                continue
            raise
        end_call(call, result)
        return result


def begin_task(agent, purpose, *, parent_call_id=None, parent_task_id=None):
    """Record a background/non-turn operation without inventing a model call."""
    trace = ACTIVE_TRACE.get()
    if trace is None or trace.closed:
        return None
    task = {
        "task_id": str(uuid.uuid4()), "purpose": purpose,
        "parent_call_id": parent_call_id, "parent_task_id": parent_task_id,
        "status": "running", "started_at": datetime.now(timezone.utc).isoformat(),
        "duration_ms": None,
    }
    task["_started_monotonic"] = time.monotonic()
    trace.tasks.append(task)
    return task


def end_task(task, status="completed"):
    if task is None:
        return
    task["status"] = status
    task["ended_at"] = datetime.now(timezone.utc).isoformat()
    task["duration_ms"] = round((time.monotonic() - task.pop("_started_monotonic", time.monotonic())) * 1000, 3)
