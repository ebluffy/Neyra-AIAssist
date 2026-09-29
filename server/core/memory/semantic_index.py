"""Semantic index seam — Chroma today, pluggable later (e.g. sqlite-vss)."""

from __future__ import annotations

from typing import Any, Optional, Protocol, runtime_checkable


@runtime_checkable
class SemanticIndex(Protocol):
    """Vector recall surface used by MemoryHub (not chronological chat_log)."""

    rag_enabled: bool

    def search(
        self,
        query: str,
        n_results: Optional[int] = None,
        *,
        user_id: Optional[str] = None,
    ) -> list[str]:
        ...

    def count(self) -> int:
        ...

    def add_knowledge(
        self, text: str, metadata: Optional[dict[str, Any]] = None
    ) -> tuple[bool, str]:
        ...


class ChromaSemanticIndex:
    """Thin adapter over LongTermMemory (Chroma)."""

    def __init__(self, long_memory: Any):
        self._ltm = long_memory

    @property
    def rag_enabled(self) -> bool:
        return bool(getattr(self._ltm, "rag_enabled", True))

    def search(
        self,
        query: str,
        n_results: Optional[int] = None,
        *,
        user_id: Optional[str] = None,
    ) -> list[str]:
        return list(
            self._ltm.search(query, n_results=n_results, user_id=user_id) or []
        )

    def count(self) -> int:
        try:
            return int(self._ltm.count())
        except Exception:
            return 0

    def add_knowledge(
        self, text: str, metadata: Optional[dict[str, Any]] = None
    ) -> tuple[bool, str]:
        return self._ltm.add_knowledge(text, metadata or {})
