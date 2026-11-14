"""Tail of the core system log, redacted before it leaves the process."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable

from core.api.log_redaction import redact_text

DEFAULT_MAX_BYTES = 262_144
MAX_LINE_CHARS = 4_000


def read_tail(
    path: Path,
    lines: int,
    *,
    max_bytes: int = DEFAULT_MAX_BYTES,
    max_line_chars: int = MAX_LINE_CHARS,
    extra_secrets: Iterable[str] = (),
) -> dict[str, Any]:
    """Return the last ``lines`` lines of ``path`` with secrets masked.

    Reads only the file tail, so a large log does not load into memory. The
    absolute path is never returned — only the file name.
    """
    target = Path(path)
    if not target.is_file():
        return {"file": target.name, "lines": [], "count": 0, "truncated": False, "missing": True}

    size = target.stat().st_size
    start = max(0, size - max(1, int(max_bytes)))
    with target.open("rb") as handle:
        if start:
            handle.seek(start)
        data = handle.read()

    text = data.decode("utf-8", errors="replace")
    rows = text.splitlines()
    head_cut = start > 0
    if head_cut and rows:
        # First line is a partial record cut by the byte window.
        rows = rows[1:]
    more_lines = len(rows) > max(1, int(lines))
    rows = rows[-max(1, int(lines)):]
    redacted = [redact_text(row[:max_line_chars], extra_secrets) for row in rows]
    return {
        "file": target.name,
        "lines": redacted,
        "count": len(redacted),
        "truncated": bool(head_cut or more_lines),
        "missing": False,
    }
