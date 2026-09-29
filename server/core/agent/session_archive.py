"""Stage 2C — controlled session archive before STM trim/reset.

Policy (``memory.session_archive``):
- on overflow / manual reset / STM threshold → optional diary + LTM digest
- never write raw full-chat into Chroma (digest via remember_knowledge only)
- Event Bus: ``memory.session_archived``
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger("neyra.agent.session_archive")

_DEFAULTS = {
    "enabled": False,
    "on_overflow": True,
    "on_manual_reset": True,
    "on_stm_threshold": False,
    "threshold_messages": 0,
    "write_diary": True,
    "write_ltm_digest": False,
    "clear_stm_after": False,
    "max_window_chars": 8000,
    "max_diary_chars": 1200,
}


def session_archive_cfg(config: dict[str, Any]) -> dict[str, Any]:
    mem = config.get("memory") if isinstance(config.get("memory"), dict) else {}
    raw = mem.get("session_archive") if isinstance(mem.get("session_archive"), dict) else {}
    out = dict(_DEFAULTS)
    out.update(raw)
    return out


def session_archive_enabled(config: dict[str, Any]) -> bool:
    return bool(session_archive_cfg(config).get("enabled"))


def _tail_chars(text: str, max_chars: int) -> str:
    """Keep the end of ``text`` (newest STM), cut on a newline when possible."""
    text = (text or "").strip()
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    chunk = text[-max_chars:]
    cut = chunk.find("\n")
    if 0 < cut < 400:
        chunk = chunk[cut + 1 :]
    return chunk.strip()


def format_stm_window(history: list[dict[str, Any]], *, max_chars: int) -> str:
    """Compact role-tagged STM window for digest (not raw Chroma dump)."""
    lines: list[str] = []
    for msg in history or []:
        role = str(msg.get("role") or "?").strip().lower()
        content = str(msg.get("content") or "").strip()
        if not content:
            continue
        tag = "U" if role == "user" else ("A" if role == "assistant" else role[:1].upper())
        lines.append(f"{tag}: {content}")
    text = "\n".join(lines).strip()
    if max_chars > 0 and len(text) > max_chars:
        text = _tail_chars(text, max_chars)
        text = "[…хвост STM…]\n" + text
    return text


def format_diary_digest(
    history: list[dict[str, Any]],
    *,
    reason: str,
    max_chars: int,
    include_assistant_tail: bool = True,
) -> str:
    """
    Short diary note without verbatim user lines (global diary → PRE-CONTEXT).

    Counts roles; may keep truncated assistant-only snippets from a *scoped* window.
    """
    n_user = 0
    n_asst = 0
    asst_bits: list[str] = []
    for msg in history or []:
        role = str(msg.get("role") or "").strip().lower()
        content = str(msg.get("content") or "").strip().replace("\n", " ")
        if not content:
            continue
        if role == "user":
            n_user += 1
        elif role == "assistant":
            n_asst += 1
            if include_assistant_tail and len(asst_bits) < 3:
                asst_bits.append(content[:120])
    head = f"[session_archive/{reason}] msgs={len(history or [])} U={n_user} A={n_asst}"
    if not asst_bits:
        return head
    body = " | ".join(asst_bits)
    note = f"{head}. A-tail: {body}"
    if max_chars > 0 and len(note) > max_chars:
        budget = max(40, max_chars - len(head) - 12)
        body = _tail_chars(body, budget)
        note = f"{head}. A-tail: {body}"
        if len(note) > max_chars:
            note = note[: max_chars - 1].rstrip() + "…"
    return note


def chat_rows_to_history(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Map chat_log rows → ``{role, content}`` oldest→newest."""
    out: list[dict[str, Any]] = []
    for r in rows or []:
        role = str(r.get("role") or "").strip().lower()
        text = str(r.get("text") or r.get("content") or "").strip()
        if not role or not text:
            continue
        if role not in ("user", "assistant", "system"):
            continue
        out.append({"role": role, "content": text})
    return out


def resolve_scoped_archive_history(
    agent: Any,
    *,
    user_id: str,
    channel_id: Optional[str],
    limit: int = 40,
) -> tuple[list[dict[str, Any]], str]:
    """
    User/channel-scoped window for archive digests.

    Process STM is shared — never use it as LTM digest source.
    Prefer Hub ``list_chat`` filtered by ``user_id`` (and optional ``channel_id``).
    Returns ``(history, source)`` where source is ``chat_log`` or empty string.
    """
    uid = str(user_id or "").strip()
    if not uid:
        return [], ""
    hub = getattr(agent, "memory_hub", None)
    if hub is None:
        return [], ""
    try:
        lim = max(2, min(int(limit or 40), 200))
        rows = hub.list_chat(
            user_id=uid,
            channel_id=str(channel_id).strip() if channel_id else None,
            limit=lim,
            offset=0,
            newest_first=True,
        )
        # SQL returns newest-first → chronological for formatting
        history = chat_rows_to_history(list(reversed(rows or [])))
        if history:
            return history, "chat_log"
    except Exception as e:
        logger.warning("session_archive: scoped chat_log read failed: %s", e)
    return [], ""


def _reason_allowed(cfg: dict[str, Any], reason: str) -> bool:
    if not bool(cfg.get("enabled")):
        return False
    if reason == "overflow":
        return bool(cfg.get("on_overflow"))
    if reason == "manual_reset":
        return bool(cfg.get("on_manual_reset"))
    if reason == "stm_threshold":
        return bool(cfg.get("on_stm_threshold")) and int(cfg.get("threshold_messages") or 0) > 0
    return False


def should_archive_stm_threshold(agent: Any) -> bool:
    cfg = session_archive_cfg(agent.config)
    if not _reason_allowed(cfg, "stm_threshold"):
        return False
    thr = int(cfg.get("threshold_messages") or 0)
    return thr > 0 and len(agent.short_memory) >= thr


async def archive_session(
    agent: Any,
    *,
    reason: str,
    user_id: str = "",
    channel_id: Optional[str] = None,
    apply_stm_policy: bool = True,
) -> dict[str, Any]:
    """
    Archive current STM window if policy allows.

    Returns a result dict (always). Soft-fails — never raises into chat pipeline.
    For ``manual_reset``, caller still clears STM afterward (reset semantics).
    For ``overflow`` / ``stm_threshold``, ``clear_stm_after`` may clear; else caller trims.
    """
    result: dict[str, Any] = {
        "ran": False,
        "reason": reason,
        "chars": 0,
        "messages": 0,
        "diary_written": False,
        "ltm_digest_written": False,
        "stm_cleared": False,
        "history_source": "",
    }
    try:
        cfg = session_archive_cfg(agent.config)
        if not _reason_allowed(cfg, reason):
            return result

        stm_history = list(agent.short_memory.get_history())
        uid = str(user_id or "").strip()
        ch = str(channel_id).strip() if channel_id is not None else None
        if ch == "":
            ch = None

        # Contentful digests: user-scoped chat_log only (process STM is shared).
        scoped_history, scoped_src = resolve_scoped_archive_history(
            agent, user_id=uid, channel_id=ch, limit=40
        )
        if not stm_history and not scoped_history:
            logger.debug("session_archive(%s): нет STM и scoped chat_log — пропуск", reason)
            return result

        max_win = int(cfg.get("max_window_chars") or _DEFAULTS["max_window_chars"])
        digest_history = scoped_history
        window = format_stm_window(digest_history, max_chars=max_win) if digest_history else ""
        result["ran"] = True
        result["chars"] = len(window)
        result["messages"] = len(digest_history) if digest_history else len(stm_history)
        result["history_source"] = scoped_src or ("stm_meta" if stm_history else "")

        hub = getattr(agent, "memory_hub", None)

        if bool(cfg.get("write_diary")) and hub is not None:
            max_diary = int(cfg.get("max_diary_chars") or _DEFAULTS["max_diary_chars"])
            if digest_history:
                note = format_diary_digest(
                    digest_history,
                    reason=reason,
                    max_chars=max_diary,
                    include_assistant_tail=True,
                )
            else:
                # No scoped window — meta counts only (never A-tail from shared STM).
                note = format_diary_digest(
                    stm_history,
                    reason=reason,
                    max_chars=max_diary,
                    include_assistant_tail=False,
                )
            try:
                hub.add_diary_note(
                    note,
                    source="session_archive",
                    meta={
                        "reason": reason,
                        "user_id": uid or None,
                        "channel_id": ch,
                        "messages": result["messages"],
                        "chars": result["chars"],
                        "history_source": result["history_source"],
                    },
                )
                result["diary_written"] = True
            except Exception as e:
                logger.warning("session_archive: diary write failed: %s", e)

        if bool(cfg.get("write_ltm_digest")) and hub is not None:
            if not uid:
                logger.warning(
                    "session_archive: LTM digest skipped — empty user_id (owner-scoped only)"
                )
            elif not digest_history or not window:
                logger.warning(
                    "session_archive: LTM digest skipped — нет user-scoped chat_log "
                    "(process STM не используем)"
                )
            else:
                try:
                    digest = await agent.summarize_ltm_corpus(window, consolidation=False)
                    digest = (digest or "").strip()
                    if digest:
                        ok, info = hub.remember_knowledge(
                            digest,
                            {
                                "type": "session_archive_digest",
                                "reason": reason,
                                "user_id": uid,
                                "channel_id": ch or "",
                                "messages": len(digest_history),
                                "history_source": "chat_log",
                            },
                        )
                        result["ltm_digest_written"] = bool(ok)
                        if not ok:
                            logger.warning("session_archive: LTM digest not stored: %s", info)
                except Exception as e:
                    logger.warning("session_archive: LTM digest failed: %s", e)

        if apply_stm_policy and reason in ("overflow", "stm_threshold") and bool(
            cfg.get("clear_stm_after")
        ):
            agent.short_memory.clear()
            result["stm_cleared"] = True
            logger.info(
                "session_archive(%s): STM очищена после архива (clear_stm_after)",
                reason,
            )

        try:
            from core.runtime.event_bus import MEMORY_SESSION_ARCHIVED, CoreEvent

            bus = getattr(agent, "event_bus", None)
            if bus is not None:
                bus.publish(
                    CoreEvent(
                        MEMORY_SESSION_ARCHIVED,
                        "core.agent.session_archive",
                        {
                            "reason": reason,
                            "user_id": uid,
                            "channel_id": ch,
                            "chars": result["chars"],
                            "messages": result["messages"],
                            "diary_written": result["diary_written"],
                            "ltm_digest_written": result["ltm_digest_written"],
                            "stm_cleared": result["stm_cleared"],
                        },
                    )
                )
        except Exception as e:
            logger.debug("session_archive: event publish failed: %s", e)

        logger.info(
            "session_archive(%s): msgs=%s chars=%s diary=%s ltm=%s cleared=%s",
            reason,
            result["messages"],
            result["chars"],
            result["diary_written"],
            result["ltm_digest_written"],
            result["stm_cleared"],
        )
        return result
    except Exception as e:
        logger.warning("session_archive soft-fail: %s", e)
        return result
