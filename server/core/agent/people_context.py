"""People mention detection and dossier blocks for prompt assembly."""

from __future__ import annotations

import re
from typing import Any, Optional

# Explicit Russian case endings (not arbitrary 1–2 letters — avoids «Максим»).
_CASE_SUFFIX = r"(?:а|у|е|ом|ой|ы|ам|ами|ах)?"


def detect_mentioned_names(text: str, name_map: dict[str, str]) -> list[str]:
    """Find known people ids by exact / word-boundary alias match only.

    No substring-of-word. Cyrillic case endings from an explicit list only
    (aliases length >= 4). Opaque UUID-like ids are exact-match only.
    """
    text_lower = (text or "").casefold()
    if not text_lower or not name_map:
        return []
    found: list[str] = []
    items = sorted(name_map.items(), key=lambda kv: len(kv[0] or ""), reverse=True)
    for name_lower, pid in items:
        alias = (name_lower or "").strip().casefold()
        if not alias or pid in found:
            continue
        is_opaque_id = len(alias) >= 32 and "-" in alias
        if re.search(r"(?<![\w])" + re.escape(alias) + r"(?![\w])", text_lower):
            found.append(pid)
            continue
        if is_opaque_id or len(alias) < 4:
            continue
        pat = r"(?<![\w])" + re.escape(alias) + _CASE_SUFFIX + r"(?![\w])"
        if re.search(pat, text_lower):
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
    if discord_user_id or username:
        ap = hub.find_person(username or "", discord_id=discord_user_id)
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
