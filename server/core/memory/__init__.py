"""
core.memory — Memory Hub v2 package.

Hub SQLite (``core.memory.hub.MemoryHub``) is the sole store for people/diary/journal/
working-memory once attached. ``stores`` holds thin helper classes
(``ShortTermMemory``, ``LongTermMemory``/Chroma, ``PeopleDB``, ``NeyraDiary``); there is
no on-disk legacy import path — see docs/adr/0001-memory-hub-v2.md.

``core.memory.legacy`` remains a one-release compat alias for ``stores``.
"""

from __future__ import annotations

from core.memory.hub import MemoryHub
from core.memory.semantic_index import ChromaSemanticIndex, SemanticIndex
from core.memory.sqlite_store import SqliteStore
from core.memory.stores import LongTermMemory, NeyraDiary, PeopleDB, ShortTermMemory

__all__ = [
    "MemoryHub",
    "SqliteStore",
    "SemanticIndex",
    "ChromaSemanticIndex",
    "ShortTermMemory",
    "LongTermMemory",
    "PeopleDB",
    "NeyraDiary",
]
