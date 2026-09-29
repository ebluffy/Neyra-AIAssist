"""
core.agent — helper shelves for the Neyra orchestrator (Phase 1R).

Main class lives in ``core.neyra`` (``from core.neyra import NeyraAgent``).
This package holds prompts, turn prep/finalize, heuristics, etc.
``NeyraAgent`` is re-exported lazily for older imports.
"""

from __future__ import annotations

from typing import Any

__all__ = [
    "DEPRECATED_OPENROUTER_MODELS",
    "EMPTY_REPLY_PLACEHOLDER",
    "LYRICS_REQUEST_MARKER",
    "NeyraAgent",
]


def __getattr__(name: str) -> Any:
    if name in __all__:
        from core import neyra as mod

        return getattr(mod, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
