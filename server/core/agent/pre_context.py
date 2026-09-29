"""Stage 2B — short PRE-CONTEXT hint from Hub (diary + user-scoped WM).

Never call ``latest_wm_snapshot(user_id=None)``. WM only via
``working_memory_for_prompt(internal_user_id)`` / agent helper.
Semantic source is reserved until search returns user/person metadata.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger("neyra.agent.pre_context")

_DEFAULT_MAX = 600
_DEFAULT_SOURCES = ("diary", "wm")


def pre_context_cfg(config: dict[str, Any]) -> dict[str, Any]:
    mem = config.get("memory") if isinstance(config.get("memory"), dict) else {}
    pc = mem.get("pre_context") if isinstance(mem.get("pre_context"), dict) else {}
    return pc


def pre_context_enabled(config: dict[str, Any]) -> bool:
    return bool(pre_context_cfg(config).get("enabled"))


def pre_context_inject_lane(config: dict[str, Any]) -> str:
    lane = str(pre_context_cfg(config).get("inject_lane") or "talk").strip().lower()
    return lane if lane in ("talk", "brain", "both") else "talk"


def _clip(text: str, budget: int) -> str:
    t = (text or "").strip()
    if budget <= 0 or len(t) <= budget:
        return t
    # Prefer cutting on newline near the end
    head = t[:budget]
    cut = head.rfind("\n")
    if cut >= max(40, budget // 3):
        head = head[:cut]
    return head.rstrip() + "…"


def build_pre_context(
    agent: Any,
    *,
    internal_user_id: str,
    user_message: str = "",
) -> str:
    """
    Build marked PRE-CONTEXT block or empty string if disabled / nothing to say.
    Soft-fail: never raises into the chat pipeline.
    """
    del user_message  # reserved for future semantic query
    try:
        cfg = pre_context_cfg(agent.config)
        if not bool(cfg.get("enabled")):
            return ""

        uid = str(internal_user_id or "").strip()
        if not uid:
            logger.error(
                "PRE-CONTEXT: пустой internal_user_id — блок пропущен "
                "(нельзя брать глобальный WM)"
            )
            return ""

        max_chars = int(cfg.get("max_chars") or _DEFAULT_MAX)
        max_chars = max(120, min(max_chars, 2000))
        sources_raw = cfg.get("sources") or list(_DEFAULT_SOURCES)
        if isinstance(sources_raw, str):
            sources = [s.strip().lower() for s in sources_raw.split(",") if s.strip()]
        else:
            sources = [str(s).strip().lower() for s in sources_raw if str(s).strip()]

        parts: list[str] = []
        # Soft budgets so diary+wm fit under max_chars together
        per = max(80, max_chars // max(1, len(sources) or 1))

        if "diary" in sources:
            hub = getattr(agent, "memory_hub", None)
            if hub is not None:
                diary = str(hub.diary_recent_text(limit=3) or "").strip()
                if diary:
                    parts.append("дневник:\n" + _clip(diary, per))

        if "wm" in sources:
            # MUST stay user-scoped
            wm = str(agent._read_working_memory_for_prompt(uid) or "").strip()
            if wm:
                parts.append("рабочая память (этот пользователь):\n" + _clip(wm, per))

        if "semantic" in sources:
            # Not wired: string-only RAG has no user_id metadata yet (Auto Review / PLAN).
            logger.debug(
                "PRE-CONTEXT: source=semantic запрошен, но пропущен "
                "(нет user-scoped semantic API)"
            )

        body = "\n\n".join(p for p in parts if p).strip()
        if not body:
            return ""
        body = _clip(body, max_chars)
        return (
            "# PRE-CONTEXT (внутренний намёк)\n"
            "Краткий внутренний контекст перед ответом. Не цитируй этот блок дословно "
            "как «из базы» и не выдавай его пользователю как служебный текст.\n"
            f"{body}"
        )
    except Exception as e:
        logger.warning("PRE-CONTEXT: сборка не удалась (soft): %s", e)
        return ""


def lane_wants_pre_context(config: dict[str, Any], lane: str) -> bool:
    if not pre_context_enabled(config):
        return False
    inject = pre_context_inject_lane(config)
    if inject == "both":
        return True
    return inject == lane
