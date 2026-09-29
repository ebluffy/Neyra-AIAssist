"""People mention detection and dossier blocks for prompt assembly."""

from __future__ import annotations

import re
from typing import Any, Optional


def detect_mentioned_names(text: str, name_map: dict[str, str]) -> list[str]:
    """Find known people ids mentioned in text (incl. simple Russian case stems)."""
    text_lower = text.lower()
    found: list[str] = []
    for name_lower, pid in name_map.items():
        if pid in found:
            continue
        if name_lower in text_lower:
            found.append(pid)
            continue
        if len(name_lower) >= 4:
            stem = name_lower[:-1]
            if re.search(r"\b" + re.escape(stem) + r"[а-яa-z]{0,2}\b", text_lower):
                found.append(pid)
    return found


def split_people_context(
    hub: Any,
    mentioned: list[str],
    username: Optional[str],
    discord_user_id: Optional[str],
) -> tuple[str, str]:
    """Active speaker dossier vs other mentioned people (no duplication)."""
    active_pid: Optional[str] = None
    u = (username or "").strip()
    if u:
        ap = hub.find_person(u, discord_id=discord_user_id)
        if ap:
            active_pid = ap["id"]
    active_block = (hub.get_person_summary(active_pid) or "").strip() if active_pid else ""
    other_ids = [pid for pid in mentioned if not active_pid or pid != active_pid]
    if not other_ids:
        return active_block, ""
    summaries = [hub.get_person_summary(pid) for pid in other_ids]
    others = "\n\n".join(s for s in summaries if s)
    return active_block, others


def shrink_people_sections(active: str, mentioned: str, max_chars: int) -> tuple[str, str]:
    """Shrink dossier blocks when over budget; prefer keeping the active speaker."""
    a, m = (active or "").strip(), (mentioned or "").strip()
    if len(a) + len(m) <= max_chars:
        return a, m
    if a:
        a_cap = min(len(a), max(max_chars // 2 + 80, max_chars - 120))
        a = a[:a_cap]
    m = m[: max(0, max_chars - len(a))]
    return a, m
