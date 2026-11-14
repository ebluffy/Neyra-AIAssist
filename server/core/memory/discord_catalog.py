"""Discord catalog: guilds, channels, members, and admin queries over chat_log.

Writes arrive from gateway events and are queued, then flushed in batches off the
event loop: a slow or locked SQLite file must never block the bot. Queries are
read-only, parameterized and paginated.

Old chat_log rows keep NULL platform/guild_id/native_* fields: nothing is
backfilled retroactively.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

logger = logging.getLogger("neyra.discord.catalog")

MAX_QUEUE = 2_000
BATCH_SIZE = 200


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _text(value: Any, limit: int = 200) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip()
    return text[:limit] if text else None


def _transaction(store) -> None:
    store._conn.execute("BEGIN IMMEDIATE")


def _commit(store) -> None:
    store._conn.execute("COMMIT")


def _rollback(store) -> None:
    try:
        store._conn.execute("ROLLBACK")
    except Exception:
        pass


# --- writes -----------------------------------------------------------------


def upsert_guild(
    store,
    *,
    guild_id: str,
    name: Optional[str] = None,
    icon_url: Optional[str] = None,
    description: Optional[str] = None,
    joined_at: Optional[str] = None,
) -> None:
    gid = _text(guild_id, 120)
    if not gid:
        return
    with store.lock:
        try:
            _transaction(store)
            store._conn.execute(
                """
                INSERT INTO discord_guilds(id, name, icon_url, description, joined_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    name = COALESCE(excluded.name, discord_guilds.name),
                    icon_url = COALESCE(excluded.icon_url, discord_guilds.icon_url),
                    description = COALESCE(excluded.description, discord_guilds.description),
                    joined_at = COALESCE(discord_guilds.joined_at, excluded.joined_at),
                    updated_at = excluded.updated_at
                """,
                (gid, _text(name), _text(icon_url, 500), _text(description, 1000), _text(joined_at, 40), _now_iso()),
            )
            _commit(store)
        except Exception:
            _rollback(store)
            raise


def upsert_channel(
    store,
    *,
    channel_id: str,
    guild_id: str,
    name: Optional[str] = None,
    channel_type: Optional[str] = None,
    parent_id: Optional[str] = None,
) -> None:
    cid = _text(channel_id, 120)
    gid = _text(guild_id, 120)
    if not cid or not gid:
        return
    with store.lock:
        try:
            _transaction(store)
            store._conn.execute(
                """
                INSERT INTO discord_channels(id, guild_id, name, type, parent_id, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    guild_id = excluded.guild_id,
                    name = excluded.name,
                    type = excluded.type,
                    parent_id = excluded.parent_id,
                    updated_at = excluded.updated_at
                """,
                (cid, gid, _text(name), _text(channel_type, 40), _text(parent_id, 120), _now_iso()),
            )
            _commit(store)
        except Exception:
            _rollback(store)
            raise


def delete_channel(store, channel_id: str) -> None:
    cid = _text(channel_id, 120)
    if not cid:
        return
    with store.lock:
        try:
            _transaction(store)
            store._conn.execute("DELETE FROM discord_channels WHERE id = ?", (cid,))
            _commit(store)
        except Exception:
            _rollback(store)
            raise


def upsert_member(
    store,
    *,
    guild_id: str,
    discord_id: str,
    username: Optional[str] = None,
    display_name: Optional[str] = None,
    is_bot: bool = False,
    person_id: Optional[str] = None,
) -> None:
    gid = _text(guild_id, 120)
    did = _text(discord_id, 120)
    if not gid or not did:
        return
    now = _now_iso()
    with store.lock:
        try:
            _transaction(store)
            store._conn.execute(
                """
                INSERT INTO discord_members(
                    guild_id, discord_id, person_id, username, display_name, is_bot, first_seen, last_seen
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(guild_id, discord_id) DO UPDATE SET
                    person_id = COALESCE(excluded.person_id, discord_members.person_id),
                    username = COALESCE(excluded.username, discord_members.username),
                    display_name = COALESCE(excluded.display_name, discord_members.display_name),
                    is_bot = excluded.is_bot,
                    last_seen = excluded.last_seen
                """,
                (gid, did, _text(person_id, 120), _text(username), _text(display_name), 1 if is_bot else 0, now, now),
            )
            _commit(store)
        except Exception:
            _rollback(store)
            raise


def remove_member(store, *, guild_id: str, discord_id: str) -> None:
    gid = _text(guild_id, 120)
    did = _text(discord_id, 120)
    if not gid or not did:
        return
    with store.lock:
        try:
            _transaction(store)
            store._conn.execute(
                "DELETE FROM discord_members WHERE guild_id = ? AND discord_id = ?", (gid, did)
            )
            _commit(store)
        except Exception:
            _rollback(store)
            raise


def apply_item(store, kind: str, payload: dict[str, Any]) -> None:
    """One queued event → one write. Unknown kinds are ignored, not raised."""
    if kind == "guild":
        upsert_guild(store, **payload)
    elif kind == "channel":
        upsert_channel(store, **payload)
    elif kind == "channel_delete":
        delete_channel(store, payload.get("channel_id", ""))
    elif kind == "member":
        upsert_member(store, **payload)
    elif kind == "member_remove":
        remove_member(store, **payload)
    else:
        logger.debug("discord catalog: unknown item kind %s", kind)


class DiscordCatalogWriter:
    """Non-blocking writer: gateway handlers only enqueue.

    A full queue drops the oldest new item with a warning instead of stalling
    the bot; the next full sync repairs the catalog.
    """

    def __init__(self, store: Any, *, max_queue: int = MAX_QUEUE) -> None:
        self._store = store
        self._queue: asyncio.Queue[tuple[str, dict[str, Any]]] = asyncio.Queue(maxsize=max_queue)
        self._task: Optional[asyncio.Task] = None
        self.dropped = 0
        self.written = 0

    def submit(self, kind: str, **payload: Any) -> bool:
        try:
            self._queue.put_nowait((kind, payload))
            return True
        except asyncio.QueueFull:
            self.dropped += 1
            if self.dropped in (1, 100, 1_000):
                logger.warning("discord catalog queue full; dropped=%s", self.dropped)
            return False

    def apply_batch(self, items: Iterable[tuple[str, dict[str, Any]]]) -> int:
        done = 0
        for kind, payload in items:
            try:
                apply_item(self._store, kind, payload)
                done += 1
            except Exception:
                logger.exception("discord catalog write failed | kind=%s", kind)
        self.written += done
        return done

    async def run(self) -> None:
        while True:
            kind, payload = await self._queue.get()
            batch = [(kind, payload)]
            while len(batch) < BATCH_SIZE:
                try:
                    batch.append(self._queue.get_nowait())
                except asyncio.QueueEmpty:
                    break
            await asyncio.to_thread(self.apply_batch, batch)

    def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self.run(), name="neyra-discord-catalog")

    async def stop(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self._task = None
        rest: list[tuple[str, dict[str, Any]]] = []
        while True:
            try:
                rest.append(self._queue.get_nowait())
            except asyncio.QueueEmpty:
                break
        if rest:
            await asyncio.to_thread(self.apply_batch, rest)


# --- reads ------------------------------------------------------------------


def _like(pattern: str) -> str:
    return "%" + pattern.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _page(limit: int, offset: int) -> tuple[int, int]:
    return max(1, min(int(limit), 200)), max(0, int(offset))


def list_guilds(store, *, limit: int = 50, offset: int = 0) -> dict[str, Any]:
    limit, offset = _page(limit, offset)
    with store.lock:
        total = int(store._conn.execute("SELECT COUNT(*) FROM discord_guilds").fetchone()[0])
        rows = store._conn.execute(
            """
            SELECT g.id, g.name, g.icon_url, g.description, g.joined_at, g.updated_at,
                   (SELECT COUNT(*) FROM discord_channels c WHERE c.guild_id = g.id) AS channel_count,
                   (SELECT COUNT(*) FROM discord_members m WHERE m.guild_id = g.id) AS member_count
            FROM discord_guilds g
            ORDER BY g.name COLLATE NOCASE, g.id
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        ).fetchall()
    return {"items": [dict(row) for row in rows], "total": total, "limit": limit, "offset": offset}


def get_guild(store, guild_id: str, *, member_limit: int = 200) -> Optional[dict[str, Any]]:
    gid = _text(guild_id, 120)
    if not gid:
        return None
    member_limit, _ = _page(member_limit, 0)
    with store.lock:
        row = store._conn.execute(
            "SELECT id, name, icon_url, description, joined_at, updated_at FROM discord_guilds WHERE id = ?",
            (gid,),
        ).fetchone()
        if row is None:
            return None
        channels = [
            dict(item)
            for item in store._conn.execute(
                "SELECT id, guild_id, name, type, parent_id, updated_at FROM discord_channels WHERE guild_id = ? ORDER BY name COLLATE NOCASE, id",
                (gid,),
            ).fetchall()
        ]
        members = [
            dict(item)
            for item in store._conn.execute(
                """
                SELECT guild_id, discord_id, person_id, username, display_name, is_bot, first_seen, last_seen
                FROM discord_members WHERE guild_id = ?
                ORDER BY COALESCE(display_name, username, discord_id) COLLATE NOCASE
                LIMIT ?
                """,
                (gid, member_limit),
            ).fetchall()
        ]
        member_total = int(
            store._conn.execute("SELECT COUNT(*) FROM discord_members WHERE guild_id = ?", (gid,)).fetchone()[0]
        )
    return {
        "guild": dict(row),
        "channels": channels,
        "members": members,
        "counts": {"channels": len(channels), "members": member_total},
    }


def list_members(
    store,
    *,
    guild_id: Optional[str] = None,
    q: Optional[str] = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    limit, offset = _page(limit, offset)
    where: list[str] = []
    params: list[Any] = []
    gid = _text(guild_id, 120)
    if gid:
        where.append("guild_id = ?")
        params.append(gid)
    needle = _text(q, 120)
    if needle:
        where.append(
            "(py_lower(COALESCE(username, '')) LIKE ? ESCAPE '\\'"
            " OR py_lower(COALESCE(display_name, '')) LIKE ? ESCAPE '\\'"
            " OR discord_id LIKE ? ESCAPE '\\')"
        )
        pattern = _like(needle.lower())
        params.extend([pattern, pattern, _like(needle)])
    clause = (" WHERE " + " AND ".join(where)) if where else ""
    with store.lock:
        total = int(store._conn.execute(f"SELECT COUNT(*) FROM discord_members{clause}", params).fetchone()[0])
        rows = store._conn.execute(
            f"""
            SELECT guild_id, discord_id, person_id, username, display_name, is_bot, first_seen, last_seen
            FROM discord_members{clause}
            ORDER BY COALESCE(display_name, username, discord_id) COLLATE NOCASE
            LIMIT ? OFFSET ?
            """,
            [*params, limit, offset],
        ).fetchall()
    return {"items": [dict(row) for row in rows], "total": total, "limit": limit, "offset": offset}


def _chat_filters(
    *,
    guild_id: Optional[str],
    channel_id: Optional[str],
    person_id: Optional[str],
    date_from: Optional[str],
    date_to: Optional[str],
    q: Optional[str],
    cursor: Optional[int],
) -> tuple[str, list[Any]]:
    where: list[str] = []
    params: list[Any] = []
    if (value := _text(guild_id, 120)):
        where.append("guild_id = ?")
        params.append(value)
    if (value := _text(channel_id, 120)):
        where.append("channel_id = ?")
        params.append(value)
    if (value := _text(person_id, 120)):
        where.append("user_id = ?")
        params.append(value)
    if (value := _text(date_from, 40)):
        where.append("ts >= ?")
        params.append(value)
    if (value := _text(date_to, 40)):
        where.append("ts <= ?")
        params.append(value)
    if (value := _text(q, 200)):
        where.append("py_lower(COALESCE(text, '')) LIKE ? ESCAPE '\\'")
        params.append(_like(value.lower()))
    if cursor is not None and int(cursor) > 0:
        where.append("id < ?")
        params.append(int(cursor))
    return ((" WHERE " + " AND ".join(where)) if where else ""), params


def _meta_fields(meta: Any) -> tuple[Optional[str], Optional[str]]:
    if isinstance(meta, str) and meta.strip():
        try:
            meta = json.loads(meta)
        except Exception:
            return None, None
    if not isinstance(meta, dict):
        return None, None
    return _text(meta.get("discord_id"), 120), _text(meta.get("username"), 120)


def list_messages(
    store,
    *,
    guild_id: Optional[str] = None,
    channel_id: Optional[str] = None,
    person_id: Optional[str] = None,
    date_from: Optional[str] = None,
    date_to: Optional[str] = None,
    q: Optional[str] = None,
    cursor: Optional[int] = None,
    limit: int = 50,
) -> dict[str, Any]:
    limit, _ = _page(limit, 0)
    clause, params = _chat_filters(
        guild_id=guild_id,
        channel_id=channel_id,
        person_id=person_id,
        date_from=date_from,
        date_to=date_to,
        q=q,
        cursor=cursor,
    )
    with store.lock:
        total = int(store._conn.execute(f"SELECT COUNT(*) FROM chat_log{clause}", params).fetchone()[0])
        rows = store._conn.execute(
            f"""
            SELECT id, ts, role, user_id, display_name, channel_id, source, text, turn_id,
                   platform, guild_id, native_message_id, native_created_at, meta
            FROM chat_log{clause}
            ORDER BY ts DESC, id DESC
            LIMIT ?
            """,
            [*params, limit],
        ).fetchall()
    items = []
    for row in rows:
        discord_id, discord_username = _meta_fields(row["meta"])
        items.append(
            {
                "id": int(row["id"]),
                "ts": row["ts"],
                "role": row["role"],
                "person_id": row["user_id"],
                "display_name": row["display_name"],
                "discord_id": discord_id,
                "discord_username": discord_username,
                "channel_id": row["channel_id"],
                "guild_id": row["guild_id"],
                "platform": row["platform"],
                "source": row["source"],
                "text": row["text"],
                "turn_id": row["turn_id"],
                "native_message_id": row["native_message_id"],
                "native_created_at": row["native_created_at"],
            }
        )
    next_cursor = items[-1]["id"] if len(items) == limit and items else None
    return {"items": items, "total": total, "limit": limit, "next_cursor": next_cursor}


def person_stats(store, person_id: str, *, days: int = 30) -> dict[str, Any]:
    pid = _text(person_id, 120)
    if not pid:
        return {"person_id": None, "messages": 0, "turns": 0, "channels": [], "first_contact": None,
                "last_contact": None, "days": []}
    days = max(1, min(int(days), 365))
    with store.lock:
        row = store._conn.execute(
            """
            SELECT COUNT(*) AS messages, COUNT(DISTINCT turn_id) AS turns,
                   MIN(ts) AS first_contact, MAX(ts) AS last_contact
            FROM chat_log WHERE user_id = ?
            """,
            (pid,),
        ).fetchone()
        channels = [
            dict(item)
            for item in store._conn.execute(
                """
                SELECT channel_id, guild_id, COUNT(*) AS messages, COUNT(DISTINCT turn_id) AS turns
                FROM chat_log WHERE user_id = ?
                GROUP BY channel_id, guild_id
                ORDER BY messages DESC
                """,
                (pid,),
            ).fetchall()
        ]
        by_day = [
            dict(item)
            for item in store._conn.execute(
                """
                SELECT substr(ts, 1, 10) AS date, COUNT(*) AS messages
                FROM chat_log
                WHERE user_id = ? AND substr(ts, 1, 10) >= date('now', ?)
                GROUP BY date ORDER BY date
                """,
                (pid, f"-{days - 1} days"),
            ).fetchall()
        ]
    return {
        "person_id": pid,
        "messages": int(row["messages"] or 0),
        "turns": int(row["turns"] or 0),
        "channels": channels,
        "first_contact": row["first_contact"],
        "last_contact": row["last_contact"],
        "days": by_day,
    }
