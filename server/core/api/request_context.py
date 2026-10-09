"""Request/trace context for Control API (contextvars + validation)."""

from __future__ import annotations

import re
import uuid
from contextvars import ContextVar

_TRACE_ID: ContextVar[str] = ContextVar("neyra_trace_id", default="")

_TRACE_RE = re.compile(r"^[A-Za-z0-9._-]{8,64}$")


def validate_trace_id(raw: str | None) -> str | None:
    """Return sanitized trace id or None if invalid/missing."""
    if not raw:
        return None
    s = str(raw).strip()
    if _TRACE_RE.fullmatch(s):
        return s
    return None


def mint_trace_id() -> str:
    return str(uuid.uuid4())


def resolve_trace_id(*candidates: str | None) -> str:
    for c in candidates:
        ok = validate_trace_id(c)
        if ok:
            return ok
    return mint_trace_id()


def set_trace_id(trace_id: str) -> None:
    _TRACE_ID.set(trace_id)


def get_trace_id() -> str:
    return _TRACE_ID.get() or ""
