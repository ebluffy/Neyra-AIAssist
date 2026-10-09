"""Logging filters: inject trace_id and redact secrets from log records."""

from __future__ import annotations

import logging
import re
from typing import Iterable

from core.api.request_context import get_trace_id

_BEARER_RE = re.compile(r"(?i)(Bearer\s+)([A-Za-z0-9._\-+/=]{8,})")
_TOKEN_QS_RE = re.compile(r"(?i)([?&](?:token|access_token|api_key|key)=)([^&\s]+)")
_SK_RE = re.compile(r"(?i)\b(sk-[A-Za-z0-9]{8,})")
_SECRET_KV_RE = re.compile(
    r"(?i)\b(api[_-]?key|api[_-]?token|secret|password|authorization)\s*[=:]\s*([^\s,;]+)"
)


def redact_text(text: str, extra_secrets: Iterable[str] | None = None) -> str:
    if not text:
        return text
    out = text
    out = _BEARER_RE.sub(r"\1***", out)
    out = _TOKEN_QS_RE.sub(r"\1***", out)
    out = _SK_RE.sub("sk-***", out)
    out = _SECRET_KV_RE.sub(r"\1=***", out)
    if extra_secrets:
        for s in extra_secrets:
            s = (s or "").strip()
            if len(s) >= 16 and s in out:
                out = out.replace(s, "***")
    return out


class TraceIdFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        tid = get_trace_id()
        if not hasattr(record, "trace_id"):
            record.trace_id = tid or "-"  # type: ignore[attr-defined]
        if tid and isinstance(record.msg, str) and "trace_id=" not in record.msg:
            record.msg = f"{record.msg} | trace_id={tid}"
        return True


class RedactionFilter(logging.Filter):
    def __init__(self, name: str = "", extra_secrets: Iterable[str] | None = None) -> None:
        super().__init__(name)
        self._extra = list(extra_secrets or [])

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            if isinstance(record.msg, str):
                record.msg = redact_text(record.msg, self._extra)
            if record.args:
                if isinstance(record.args, dict):
                    record.args = {
                        k: redact_text(str(v), self._extra) if isinstance(v, str) else v
                        for k, v in record.args.items()
                    }
                elif isinstance(record.args, tuple):
                    record.args = tuple(
                        redact_text(a, self._extra) if isinstance(a, str) else a for a in record.args
                    )
        except Exception:
            pass
        return True


def install_log_filters(extra_secrets: Iterable[str] | None = None) -> None:
    """Attach filters to root + uvicorn loggers (idempotent-ish)."""
    trace = TraceIdFilter()
    red = RedactionFilter(extra_secrets=extra_secrets)
    for name in ("", "neyra", "neyra.api", "uvicorn", "uvicorn.access", "uvicorn.error"):
        lg = logging.getLogger(name)
        if not any(isinstance(f, TraceIdFilter) for f in lg.filters):
            lg.addFilter(trace)
        if not any(isinstance(f, RedactionFilter) for f in lg.filters):
            lg.addFilter(red)
