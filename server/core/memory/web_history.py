"""Web chat history and per-user notes stored in the Memory Hub SQLite.

Every query is scoped by the signed web user id; a foreign id behaves exactly
like a missing one (404 at the API layer, ``None``/``False`` here). Threads and
notes use soft delete (``deleted_at``); messages are removed physically.
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

_UNSET = object()
_CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _bool(value: Any) -> bool:
    return bool(value)


def _thread_dict(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "title": row["title"],
        "archived": _bool(row["archived"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "last_message_at": row["last_message_at"],
        "message_count": int(row["message_count"] or 0),
    }


def _message_dict(row: Any) -> dict[str, Any]:
    attachments: list[Any] = []
    raw = row["attachments_json"]
    if isinstance(raw, str) and raw:
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                attachments = parsed
        except Exception:
            attachments = []
    return {
        "id": row["id"],
        "thread_id": row["thread_id"],
        "seq": int(row["seq"]),
        "role": row["role"],
        "content": row["content"],
        "attachments": attachments,
        "model": row["model"],
        "created_at": row["created_at"],
    }


def _note_dict(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "thread_id": row["thread_id"],
        "text": row["text"],
        "pinned": _bool(row["pinned"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
    }


def _tx(store) -> None:
    store._conn.execute("BEGIN IMMEDIATE")


def _commit(store) -> None:
    store._conn.execute("COMMIT")


def _rollback(store) -> None:
    try:
        store._conn.execute("ROLLBACK")
    except Exception:
        pass


# --- threads ----------------------------------------------------------------


def create_thread(store, user_id: str, title: Optional[str] = None) -> dict[str, Any]:
    thread_id = uuid.uuid4().hex
    now = _now_iso()
    with store.lock:
        try:
            _tx(store)
            store._conn.execute(
                "INSERT INTO web_threads(id, user_id, title, archived, created_at, updated_at)"
                " VALUES (?, ?, ?, 0, ?, ?)",
                (thread_id, user_id, (title or "").strip() or None, now, now),
            )
            _commit(store)
        except Exception:
            _rollback(store)
            raise
        row = store._conn.execute(
            "SELECT id, title, archived, created_at, updated_at, NULL AS last_message_at, 0 AS message_count"
            " FROM web_threads WHERE id = ?",
            (thread_id,),
        ).fetchone()
    return _thread_dict(row)


def _thread_select() -> str:
    return (
        "SELECT t.id, t.title, t.archived, t.created_at, t.updated_at,"
        " (SELECT MAX(m.created_at) FROM web_thread_messages m WHERE m.thread_id = t.id) AS last_message_at,"
        " (SELECT COUNT(*) FROM web_thread_messages m WHERE m.thread_id = t.id) AS message_count"
        " FROM web_threads t"
    )


def _parse_thread_cursor(cursor: Optional[str]) -> Optional[tuple[str, str]]:
    if not cursor:
        return None
    raw = str(cursor)
    if "|" not in raw:
        return None
    updated_at, thread_id = raw.split("|", 1)
    if not updated_at or not thread_id:
        return None
    return updated_at, thread_id


def list_threads(
    store,
    user_id: str,
    *,
    limit: int = 50,
    cursor: Optional[str] = None,
) -> dict[str, Any]:
    limit = max(1, min(int(limit), 100))
    where = ["t.user_id = ?", "t.deleted_at IS NULL"]
    params: list[Any] = [user_id]
    parsed = _parse_thread_cursor(cursor)
    if parsed is not None:
        updated_at, thread_id = parsed
        where.append("(t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))")
        params.extend([updated_at, updated_at, thread_id])
    with store.lock:
        rows = store._conn.execute(
            _thread_select() + " WHERE " + " AND ".join(where) +
            " ORDER BY t.updated_at DESC, t.id DESC LIMIT ?",
            [*params, limit + 1],
        ).fetchall()
    items = [_thread_dict(row) for row in rows[:limit]]
    next_cursor = None
    if len(rows) > limit and items:
        next_cursor = f"{items[-1]['updated_at']}|{items[-1]['id']}"
    return {"items": items, "next_cursor": next_cursor}


def get_thread(store, user_id: str, thread_id: str) -> Optional[dict[str, Any]]:
    with store.lock:
        row = store._conn.execute(
            _thread_select() + " WHERE t.id = ? AND t.user_id = ? AND t.deleted_at IS NULL",
            (thread_id, user_id),
        ).fetchone()
    return _thread_dict(row) if row is not None else None


def update_thread(
    store,
    user_id: str,
    thread_id: str,
    *,
    title: Any = _UNSET,
    archived: Any = _UNSET,
) -> Optional[dict[str, Any]]:
    sets: list[str] = []
    params: list[Any] = []
    if title is not _UNSET:
        value = (str(title).strip() if title is not None else "")[:200]
        sets.append("title = ?")
        params.append(value or None)
    if archived is not _UNSET:
        sets.append("archived = ?")
        params.append(1 if archived else 0)
    if not sets:
        return get_thread(store, user_id, thread_id)
    sets.append("updated_at = ?")
    params.append(_now_iso())
    with store.lock:
        try:
            _tx(store)
            cur = store._conn.execute(
                "UPDATE web_threads SET " + ", ".join(sets) +
                " WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
                [*params, thread_id, user_id],
            )
            _commit(store)
        except Exception:
            _rollback(store)
            raise
    if cur.rowcount == 0:
        return None
    return get_thread(store, user_id, thread_id)


def soft_delete_thread(store, user_id: str, thread_id: str) -> bool:
    now = _now_iso()
    with store.lock:
        try:
            _tx(store)
            cur = store._conn.execute(
                "UPDATE web_threads SET deleted_at = ?, updated_at = ?"
                " WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
                (now, now, thread_id, user_id),
            )
            _commit(store)
        except Exception:
            _rollback(store)
            raise
    return cur.rowcount == 1


# --- messages ---------------------------------------------------------------


def list_messages(
    store,
    user_id: str,
    thread_id: str,
    *,
    limit: int = 100,
    before: Optional[int] = None,
) -> Optional[dict[str, Any]]:
    """Newest ``limit`` messages (older than ``before``) in ascending seq order."""
    if get_thread(store, user_id, thread_id) is None:
        return None
    limit = max(1, min(int(limit), 100))
    where = ["thread_id = ?", "user_id = ?"]
    params: list[Any] = [thread_id, user_id]
    if before is not None:
        where.append("seq < ?")
        params.append(int(before))
    with store.lock:
        rows = store._conn.execute(
            "SELECT id, thread_id, seq, role, content, attachments_json, model, created_at"
            " FROM web_thread_messages WHERE " + " AND ".join(where) +
            " ORDER BY seq DESC LIMIT ?",
            [*params, limit + 1],
        ).fetchall()
    has_more = len(rows) > limit
    rows = list(reversed(rows[:limit]))
    messages = [_message_dict(row) for row in rows]
    return {
        "messages": messages,
        "has_more": has_more,
        "next_before": messages[0]["seq"] if has_more and messages else None,
    }


def append_message(
    store,
    user_id: str,
    thread_id: str,
    *,
    role: str,
    content: str,
    attachments: Optional[list[Any]] = None,
    model: Optional[str] = None,
    client_id: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Append a message with the next seq; ``client_id`` makes retries idempotent."""
    clean_role = "assistant" if str(role).strip().lower() == "assistant" else "user"
    text = str(content or "")
    if not text.strip():
        raise ValueError("empty content")
    payload = attachments if isinstance(attachments, list) else []
    attachments_json = json.dumps(payload[:10], ensure_ascii=False)[:20000] if payload else None
    client = str(client_id or "").strip()
    message_id = client if client and _CLIENT_ID_RE.match(client) else uuid.uuid4().hex
    now = _now_iso()
    with store.lock:
        try:
            _tx(store)
            thread = store._conn.execute(
                "SELECT 1 FROM web_threads WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
                (thread_id, user_id),
            ).fetchone()
            if thread is None:
                _rollback(store)
                return None
            if client:
                existing = store._conn.execute(
                    "SELECT id, thread_id, seq, role, content, attachments_json, model, created_at"
                    " FROM web_thread_messages WHERE id = ? AND thread_id = ? AND user_id = ?",
                    (message_id, thread_id, user_id),
                ).fetchone()
                if existing is not None:
                    _commit(store)
                    return _message_dict(existing)
            row = store._conn.execute(
                "SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM web_thread_messages WHERE thread_id = ?",
                (thread_id,),
            ).fetchone()
            seq = int(row["next_seq"])
            store._conn.execute(
                "INSERT INTO web_thread_messages(id, thread_id, user_id, seq, role, content,"
                " attachments_json, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (message_id, thread_id, user_id, seq, clean_role, text, attachments_json, model, now),
            )
            store._conn.execute(
                "UPDATE web_threads SET updated_at = ? WHERE id = ? AND user_id = ?",
                (now, thread_id, user_id),
            )
            _commit(store)
        except Exception:
            _rollback(store)
            raise
        inserted = store._conn.execute(
            "SELECT id, thread_id, seq, role, content, attachments_json, model, created_at"
            " FROM web_thread_messages WHERE id = ?",
            (message_id,),
        ).fetchone()
    return _message_dict(inserted)


def delete_message(store, user_id: str, thread_id: str, message_id: str) -> bool:
    with store.lock:
        try:
            _tx(store)
            cur = store._conn.execute(
                "DELETE FROM web_thread_messages WHERE id = ? AND thread_id = ? AND user_id = ?",
                (message_id, thread_id, user_id),
            )
            if cur.rowcount:
                store._conn.execute(
                    "UPDATE web_threads SET updated_at = ? WHERE id = ? AND user_id = ?",
                    (_now_iso(), thread_id, user_id),
                )
            _commit(store)
        except Exception:
            _rollback(store)
            raise
    return cur.rowcount == 1


# --- notes ------------------------------------------------------------------


def _note_select() -> str:
    return "SELECT id, thread_id, text, pinned, created_at, updated_at FROM web_notes"


def _parse_note_cursor(cursor: Optional[str]) -> Optional[tuple[str, str]]:
    if not cursor or "|" not in str(cursor):
        return None
    updated_at, note_id = str(cursor).split("|", 1)
    return (updated_at, note_id) if updated_at and note_id else None


def list_notes(
    store,
    user_id: str,
    *,
    thread_id: Optional[str] = None,
    limit: int = 50,
    cursor: Optional[str] = None,
) -> dict[str, Any]:
    limit = max(1, min(int(limit), 100))
    where = ["user_id = ?", "deleted_at IS NULL"]
    params: list[Any] = [user_id]
    if thread_id:
        where.append("thread_id = ?")
        params.append(thread_id)
    parsed = _parse_note_cursor(cursor)
    if parsed is not None:
        updated_at, note_id = parsed
        where.append("(updated_at < ? OR (updated_at = ? AND id < ?))")
        params.extend([updated_at, updated_at, note_id])
    with store.lock:
        rows = store._conn.execute(
            _note_select() + " WHERE " + " AND ".join(where) +
            " ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ?",
            [*params, limit + 1],
        ).fetchall()
    items = [_note_dict(row) for row in rows[:limit]]
    next_cursor = f"{items[-1]['updated_at']}|{items[-1]['id']}" if len(rows) > limit and items else None
    return {"items": items, "next_cursor": next_cursor}


def get_note(store, user_id: str, note_id: str) -> Optional[dict[str, Any]]:
    with store.lock:
        row = store._conn.execute(
            _note_select() + " WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
            (note_id, user_id),
        ).fetchone()
    return _note_dict(row) if row is not None else None


def create_note(
    store,
    user_id: str,
    *,
    text: str,
    thread_id: Optional[str] = None,
    pinned: bool = False,
) -> dict[str, Any]:
    note_id = uuid.uuid4().hex
    now = _now_iso()
    with store.lock:
        try:
            _tx(store)
            store._conn.execute(
                "INSERT INTO web_notes(id, user_id, thread_id, text, pinned, created_at, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (note_id, user_id, (thread_id or "").strip() or None, text, 1 if pinned else 0, now, now),
            )
            _commit(store)
        except Exception:
            _rollback(store)
            raise
    return get_note(store, user_id, note_id)  # type: ignore[return-value]


def update_note(
    store,
    user_id: str,
    note_id: str,
    *,
    text: Any = _UNSET,
    pinned: Any = _UNSET,
    thread_id: Any = _UNSET,
) -> Optional[dict[str, Any]]:
    sets: list[str] = []
    params: list[Any] = []
    if text is not _UNSET:
        sets.append("text = ?")
        params.append(str(text or ""))
    if pinned is not _UNSET:
        sets.append("pinned = ?")
        params.append(1 if pinned else 0)
    if thread_id is not _UNSET:
        sets.append("thread_id = ?")
        params.append((str(thread_id).strip() if thread_id else "") or None)
    if not sets:
        return get_note(store, user_id, note_id)
    sets.append("updated_at = ?")
    params.append(_now_iso())
    with store.lock:
        try:
            _tx(store)
            cur = store._conn.execute(
                "UPDATE web_notes SET " + ", ".join(sets) +
                " WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
                [*params, note_id, user_id],
            )
            _commit(store)
        except Exception:
            _rollback(store)
            raise
    if cur.rowcount == 0:
        return None
    return get_note(store, user_id, note_id)


def soft_delete_note(store, user_id: str, note_id: str) -> bool:
    now = _now_iso()
    with store.lock:
        try:
            _tx(store)
            cur = store._conn.execute(
                "UPDATE web_notes SET deleted_at = ?, updated_at = ?"
                " WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
                (now, now, note_id, user_id),
            )
            _commit(store)
        except Exception:
            _rollback(store)
            raise
    return cur.rowcount == 1
