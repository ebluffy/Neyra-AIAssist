"""Stage 2E — server-side Fast-Path for unambiguous smart-home commands.

Regex allowlist only (no LLM). Miss / ambiguous → full brain path.
«Ещё раз / то же» resolves the last fast_path action from user-scoped chat_log.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any, Optional

logger = logging.getLogger("neyra.agent.fast_path")

_DEFAULT_INTENTS: list[dict[str, Any]] = [
    {
        "name": "light_off",
        "patterns": [r"(?i)^\s*(выключи|погаси)\s+(свет|лампу)\s*[.!?]?\s*$"],
        "event_type": "home.light.turn_off",
        "target": "default_light",
        "reply": "Выключаю свет.",
    },
    {
        "name": "light_on",
        "patterns": [r"(?i)^\s*(включи|зажги)\s+(свет|лампу)\s*[.!?]?\s*$"],
        "event_type": "home.light.turn_on",
        "target": "default_light",
        "reply": "Включаю свет.",
    },
    {
        "name": "repeat_last",
        "patterns": [r"(?i)^\s*(ещ[её]\s+раз|то\s+же|повтори)\s*[.!?]?\s*$"],
        "event_type": "home.repeat_last",
        "target": "",
        "reply": "",
    },
]


@dataclass(frozen=True)
class FastPathHit:
    intent: str
    event_type: str
    target: str
    reply: str
    reason: str
    confidence: float = 1.0


def fast_path_cfg(config: dict[str, Any]) -> dict[str, Any]:
    agent = config.get("agent") if isinstance(config.get("agent"), dict) else {}
    fp = agent.get("fast_path") if isinstance(agent.get("fast_path"), dict) else {}
    return fp


def fast_path_enabled(config: dict[str, Any]) -> bool:
    return bool(fast_path_cfg(config).get("enabled"))


def _intents(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    raw = cfg.get("intents")
    if isinstance(raw, list) and raw:
        return [i for i in raw if isinstance(i, dict)]
    return list(_DEFAULT_INTENTS)


def match_fast_path(text: str, config: dict[str, Any]) -> Optional[FastPathHit]:
    """Return a hit only for unambiguous allowlist matches."""
    cfg = fast_path_cfg(config)
    if not bool(cfg.get("enabled")):
        return None
    msg = (text or "").strip()
    if not msg:
        return None
    min_conf = float(cfg.get("min_confidence") or 1.0)
    hits: list[FastPathHit] = []
    for intent in _intents(cfg):
        name = str(intent.get("name") or "").strip() or "unnamed"
        patterns = intent.get("patterns") or []
        if not isinstance(patterns, list):
            continue
        for pat in patterns:
            try:
                if re.search(str(pat), msg):
                    hits.append(
                        FastPathHit(
                            intent=name,
                            event_type=str(intent.get("event_type") or f"home.{name}"),
                            target=str(intent.get("target") or ""),
                            reply=str(intent.get("reply") or ""),
                            reason=f"allowlist:{name}",
                            confidence=1.0,
                        )
                    )
                    break
            except re.error as e:
                logger.warning("fast_path: bad pattern for %s: %s", name, e)
    if not hits:
        return None
    if len(hits) > 1:
        logger.info(
            "fast_path.miss reason=ambiguous_multi_hit intents=%s",
            [h.intent for h in hits],
        )
        return None
    hit = hits[0]
    if hit.confidence < min_conf:
        logger.info("fast_path.miss reason=low_confidence intent=%s", hit.intent)
        return None
    return hit


def _meta_fast_path(meta: Any) -> Optional[dict[str, Any]]:
    if not isinstance(meta, dict):
        return None
    fp = meta.get("fast_path")
    return fp if isinstance(fp, dict) else None


def resolve_repeat_last(
    agent: Any,
    *,
    user_id: str,
    channel_id: Optional[str],
) -> Optional[FastPathHit]:
    """Find last non-repeat fast_path action for this user (optional channel)."""
    uid = str(user_id or "").strip()
    if not uid:
        logger.info("fast_path.miss reason=repeat_no_user_id")
        return None
    hub = getattr(agent, "memory_hub", None)
    if hub is None:
        logger.info("fast_path.miss reason=repeat_no_hub")
        return None
    cid = str(channel_id).strip() if channel_id else None
    try:
        rows = hub.list_chat(
            user_id=uid,
            channel_id=cid,
            limit=40,
            offset=0,
            newest_first=True,
        )
    except Exception as e:
        logger.warning("fast_path: list_chat failed: %s", e)
        return None

    for row in rows or []:
        fp = _meta_fast_path(row.get("meta"))
        if not fp:
            continue
        intent = str(fp.get("intent") or "")
        event_type = str(fp.get("event_type") or "")
        if intent == "repeat_last" or event_type.endswith("repeat_last"):
            continue
        if not event_type.startswith("home."):
            continue
        reply = str(fp.get("reply") or "").strip() or "Повторяю прошлую команду."
        return FastPathHit(
            intent=intent or "repeat_resolved",
            event_type=event_type,
            target=str(fp.get("target") or ""),
            reply=reply,
            reason="repeat_last_from_chat_log",
            confidence=1.0,
        )
    logger.info("fast_path.miss reason=repeat_nothing_found user_id=%s", uid)
    return None


def _publish_home_event(
    agent: Any,
    hit: FastPathHit,
    *,
    user_id: str,
    channel_id: Optional[str],
    request_text: str,
) -> None:
    try:
        from core.runtime.event_bus import CoreEvent

        bus = getattr(agent, "event_bus", None)
        if bus is None:
            return
        bus.publish(
            CoreEvent(
                hit.event_type,
                "core.agent.fast_path",
                {
                    "action": hit.intent,
                    "target": hit.target,
                    "user_id": user_id,
                    "channel_id": channel_id,
                    "request_text": request_text,
                    "reason": hit.reason,
                    "reply": hit.reply,
                },
            )
        )
        logger.info(
            "fast_path.home_event published type=%s intent=%s target=%s "
            "(no hardware consumer yet — mock/plugin is plan stage 2)",
            hit.event_type,
            hit.intent,
            hit.target,
        )
    except Exception as e:
        logger.debug("fast_path: event publish failed: %s", e)


async def try_handle_fast_path(
    agent: Any,
    *,
    user_message: str,
    username: Optional[str],
    discord_user_id: Optional[str],
    channel_id: Optional[str],
    author_display_name: Optional[str],
    vision_images: Optional[list],
    lyrics_marker: str,
    source: str,
) -> Optional[dict[str, Any]]:
    """
    If Fast-Path hits: publish home.* event, finalize turn, return chat result dict.
    Otherwise return None (caller continues full brain path).
    """
    if not fast_path_enabled(agent.config):
        return None
    if vision_images:
        return None
    if lyrics_marker and lyrics_marker in (user_message or ""):
        return None

    hit = match_fast_path(user_message, agent.config)
    if hit is None:
        return None

    internal_uid = agent._resolve_internal_user_id(discord_user_id, username)
    try:
        speaker_label = agent._resolve_speaker_label(
            username, discord_user_id, author_display_name
        )
    except Exception:
        speaker_label = str(username or author_display_name or "user")

    if hit.intent == "repeat_last" or hit.event_type.endswith("repeat_last"):
        resolved = resolve_repeat_last(
            agent, user_id=internal_uid, channel_id=channel_id
        )
        if resolved is None:
            return None
        hit = resolved

    reply = (hit.reply or "").strip() or "Ок, сделала."
    logger.info(
        "fast_path.hit intent=%s event=%s reason=%s user_id=%s channel_id=%s",
        hit.intent,
        hit.event_type,
        hit.reason,
        internal_uid,
        channel_id,
    )
    _publish_home_event(
        agent,
        hit,
        user_id=internal_uid,
        channel_id=channel_id,
        request_text=user_message,
    )

    from core.agent.turn_finalize import finalize_successful_turn

    await finalize_successful_turn(
        agent,
        user_message=user_message,
        clean_text=reply,
        thoughts="",
        sounds=[],
        username=username,
        discord_user_id=discord_user_id,
        channel_id=channel_id,
        speaker_label=speaker_label,
        internal_uid=internal_uid,
        vision_images=None,
        saved_facts=[],
        source=source,
        stm_trimmed=False,
        extra_meta={
            "fast_path": {
                "intent": hit.intent,
                "event_type": hit.event_type,
                "target": hit.target,
                "reply": reply,
                "reason": hit.reason,
            }
        },
    )
    return {
        "text": reply,
        "sounds": [],
        "thoughts": "",
        "raw": reply,
        "fast_path": True,
        "fast_path_intent": hit.intent,
        "fast_path_event": hit.event_type,
    }
