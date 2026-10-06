"""SQLite store for Memory Hub v2 (single-writer via RLock + WAL)."""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from core.memory.migrations import MIGRATIONS
from core.runtime.timeutil import now_storage_iso, to_utc_iso

logger = logging.getLogger("neyra.memory.sqlite")


def _now_iso() -> str:
    """UTC ISO for SQLite ts columns (stable TEXT ORDER BY)."""
    return now_storage_iso()


class SqliteStore:
    """Process-local SQLite access. All methods assume the Hub holds the write lock."""

    def __init__(self, db_path: str | Path):
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(
            str(self.path),
            check_same_thread=False,
            isolation_level=None,  # autocommit; we use explicit BEGIN
        )
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA foreign_keys=ON")
        self.migrate()

    @property
    def lock(self) -> threading.RLock:
        return self._lock

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def migrate(self) -> None:
        with self._lock:
            self._conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations ("
                "version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)"
            )
            cur = self._conn.execute("SELECT version FROM schema_migrations")
            applied = {int(r[0]) for r in cur.fetchall()}
            for version, sql in MIGRATIONS:
                if version in applied:
                    continue
                logger.info("SQLite migrate → v%s (%s)", version, self.path)
                # executescript auto-commits; do not wrap in BEGIN/COMMIT
                self._conn.executescript(sql)
                self._conn.execute(
                    "INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                    (version, _now_iso()),
                )

    def append_chat_rows(self, rows: list[dict[str, Any]]) -> list[int]:
        """Insert chat_log rows; returns new ids."""
        ids: list[int] = []
        with self._lock:
            try:
                self._conn.execute("BEGIN IMMEDIATE")
                for row in rows:
                    meta = row.get("meta")
                    if meta is not None and not isinstance(meta, str):
                        meta = json.dumps(meta, ensure_ascii=False)
                    cur = self._conn.execute(
                        """
                        INSERT INTO chat_log(
                            ts, role, user_id, display_name, channel_id, source,
                            text, turn_id, latency_ms, emotion, mood, meta
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            to_utc_iso(row.get("ts")) if row.get("ts") else _now_iso(),
                            str(row.get("role") or ""),
                            row.get("user_id"),
                            row.get("display_name"),
                            row.get("channel_id"),
                            row.get("source"),
                            str(row.get("text") or ""),
                            row.get("turn_id"),
                            row.get("latency_ms"),
                            row.get("emotion"),
                            row.get("mood"),
                            meta,
                        ),
                    )
                    ids.append(int(cur.lastrowid))
                self._conn.execute("COMMIT")
            except Exception:
                try:
                    self._conn.execute("ROLLBACK")
                except Exception:
                    pass
                raise
        return ids

    def list_chat(
        self,
        *,
        user_id: Optional[str] = None,
        channel_id: Optional[str] = None,
        limit: int = 20,
        offset: int = 0,
        newest_first: bool = True,
    ) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 500))
        offset = max(0, int(offset))
        clauses: list[str] = []
        params: list[Any] = []
        if user_id:
            clauses.append("user_id = ?")
            params.append(user_id)
        if channel_id:
            clauses.append("channel_id = ?")
            params.append(channel_id)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        order = "DESC" if newest_first else "ASC"
        sql = (
            f"SELECT * FROM chat_log {where} "
            f"ORDER BY ts {order}, id {order} LIMIT ? OFFSET ?"
        )
        params.extend([limit, offset])
        with self._lock:
            cur = self._conn.execute(sql, params)
            return [self._row_to_dict(r) for r in cur.fetchall()]

    def count_table(self, table: str) -> int:
        allowed = {
            "chat_log",
            "people",
            "person_facts",
            "person_accounts",
            "merge_log",
            "diary_notes",
            "journal_entries",
            "working_memory_snapshots",
            "semantic_outbox",
        }
        if table not in allowed:
            raise ValueError(f"count_table: unknown table {table}")
        with self._lock:
            cur = self._conn.execute(f"SELECT COUNT(*) FROM {table}")
            return int(cur.fetchone()[0])

    def clear_table(self, table: str) -> int:
        """DELETE all rows; returns rowcount. Allowed tables only."""
        allowed = {
            "chat_log",
            "people",
            "person_facts",
            "person_accounts",
            "merge_log",
            "diary_notes",
            "journal_entries",
            "working_memory_snapshots",
            "semantic_outbox",
        }
        if table not in allowed:
            raise ValueError(f"clear_table: unknown table {table}")
        with self._lock:
            # FK: clear children before people
            if table == "people":
                self._conn.execute("DELETE FROM person_facts")
                self._conn.execute("DELETE FROM person_accounts")
                cur = self._conn.execute("DELETE FROM people")
                return int(cur.rowcount)
            cur = self._conn.execute(f"DELETE FROM {table}")
            return int(cur.rowcount)

    def schema_version(self) -> int:
        with self._lock:
            cur = self._conn.execute(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations"
            )
            return int(cur.fetchone()[0])

    def _dumps(self, value: Any) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, str):
            return value
        return json.dumps(value, ensure_ascii=False)

    def upsert_person(
        self,
        *,
        person_id: str,
        display_name: Optional[str] = None,
        aliases: Any = None,
        meta: Any = None,
    ) -> None:
        now = _now_iso()
        with self._lock:
            cur = self._conn.execute(
                "SELECT person_id FROM people WHERE person_id = ?", (person_id,)
            )
            exists = cur.fetchone() is not None
            if exists:
                self._conn.execute(
                    """
                    UPDATE people
                    SET display_name = COALESCE(?, display_name),
                        aliases = COALESCE(?, aliases),
                        updated_at = ?,
                        meta = COALESCE(?, meta)
                    WHERE person_id = ?
                    """,
                    (
                        display_name,
                        self._dumps(aliases),
                        now,
                        self._dumps(meta),
                        person_id,
                    ),
                )
            else:
                self._conn.execute(
                    """
                    INSERT INTO people(person_id, display_name, aliases, created_at, updated_at, meta)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        person_id,
                        display_name,
                        self._dumps(aliases),
                        now,
                        now,
                        self._dumps(meta),
                    ),
                )

    def add_person_fact(
        self,
        *,
        person_id: str,
        fact: str,
        emotion_note: Optional[str] = None,
        source: Optional[str] = None,
        meta: Any = None,
        created_at: Optional[str] = None,
    ) -> int:
        with self._lock:
            cur = self._conn.execute(
                """
                INSERT INTO person_facts(person_id, fact, emotion_note, created_at, source, meta)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    person_id,
                    fact,
                    emotion_note,
                    to_utc_iso(created_at) if created_at else _now_iso(),
                    source,
                    self._dumps(meta),
                ),
            )
            return int(cur.lastrowid)

    def get_person(self, person_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            cur = self._conn.execute(
                "SELECT * FROM people WHERE person_id = ?", (person_id,)
            )
            row = cur.fetchone()
            if not row:
                return None
            return self._person_row_to_dict(row)

    def list_people(self) -> list[dict[str, Any]]:
        """All people rows (for identity lookup / cache hydrate)."""
        with self._lock:
            cur = self._conn.execute(
                "SELECT * FROM people ORDER BY person_id ASC"
            )
            return [self._person_row_to_dict(r) for r in cur.fetchall()]

    def list_person_facts(self, person_id: str, limit: int = 20) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 200))
        with self._lock:
            cur = self._conn.execute(
                """
                SELECT * FROM person_facts
                WHERE person_id = ?
                ORDER BY id DESC LIMIT ?
                """,
                (person_id, limit),
            )
            return [self._row_to_dict(r) for r in cur.fetchall()]

    def delete_person_fact(self, person_id: str, fact_id: int) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM person_facts WHERE person_id = ? AND id = ?",
                (person_id, int(fact_id)),
            )
            return cur.rowcount > 0

    def delete_person(self, person_id: str) -> bool:
        with self._lock:
            self._conn.execute("DELETE FROM person_facts WHERE person_id = ?", (person_id,))
            self._conn.execute("DELETE FROM person_accounts WHERE person_id = ?", (person_id,))
            cur = self._conn.execute("DELETE FROM people WHERE person_id = ?", (person_id,))
            return cur.rowcount > 0

    def upsert_person_account(
        self,
        *,
        person_id: str,
        platform: str,
        platform_user_id: str,
        handle: Optional[str] = None,
        display_name: Optional[str] = None,
        avatar_url: Optional[str] = None,
    ) -> None:
        now = _now_iso()
        plat = (platform or "").strip().lower()
        puid = (platform_user_id or "").strip()
        if not plat or not puid:
            raise ValueError("platform and platform_user_id required")
        with self._lock:
            cur = self._conn.execute(
                "SELECT id, person_id FROM person_accounts WHERE platform = ? AND platform_user_id = ?",
                (plat, puid),
            )
            row = cur.fetchone()
            if row:
                self._conn.execute(
                    """
                    UPDATE person_accounts
                    SET person_id = ?,
                        handle = COALESCE(?, handle),
                        display_name = COALESCE(?, display_name),
                        avatar_url = COALESCE(?, avatar_url),
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        person_id,
                        handle,
                        display_name,
                        avatar_url,
                        now,
                        int(row["id"]),
                    ),
                )
            else:
                self._conn.execute(
                    """
                    INSERT INTO person_accounts(
                        person_id, platform, platform_user_id, handle, display_name, avatar_url,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (person_id, plat, puid, handle, display_name, avatar_url, now, now),
                )

    def get_account(
        self, platform: str, platform_user_id: str
    ) -> Optional[dict[str, Any]]:
        plat = (platform or "").strip().lower()
        puid = (platform_user_id or "").strip()
        if not plat or not puid:
            return None
        with self._lock:
            cur = self._conn.execute(
                "SELECT * FROM person_accounts WHERE platform = ? AND platform_user_id = ?",
                (plat, puid),
            )
            row = cur.fetchone()
            return self._row_to_dict(row) if row else None

    def list_accounts_for_person(self, person_id: str) -> list[dict[str, Any]]:
        with self._lock:
            cur = self._conn.execute(
                "SELECT * FROM person_accounts WHERE person_id = ? ORDER BY id ASC",
                (person_id,),
            )
            return [self._row_to_dict(r) for r in cur.fetchall()]

    def find_person_id_by_handle(self, handle: str) -> Optional[str]:
        h = (handle or "").strip()
        if not h:
            return None
        with self._lock:
            cur = self._conn.execute(
                """
                SELECT person_id FROM person_accounts
                WHERE lower(handle) = lower(?)
                LIMIT 1
                """,
                (h,),
            )
            row = cur.fetchone()
            if row:
                return str(row["person_id"])
            cur = self._conn.execute(
                """
                SELECT person_id FROM people
                WHERE lower(person_id) = lower(?)
                   OR lower(COALESCE(display_name, '')) = lower(?)
                LIMIT 1
                """,
                (h, h),
            )
            row = cur.fetchone()
            return str(row["person_id"]) if row else None

    def reassign_accounts(self, source_person_id: str, survivor_id: str) -> int:
        with self._lock:
            cur = self._conn.execute(
                "UPDATE person_accounts SET person_id = ?, updated_at = ? WHERE person_id = ?",
                (survivor_id, _now_iso(), source_person_id),
            )
            return int(cur.rowcount)

    def reassign_facts(self, source_person_id: str, survivor_id: str) -> int:
        with self._lock:
            cur = self._conn.execute(
                "UPDATE person_facts SET person_id = ? WHERE person_id = ?",
                (survivor_id, source_person_id),
            )
            return int(cur.rowcount)

    def add_merge_log(
        self,
        *,
        survivor_id: str,
        source_id: str,
        reason: Optional[str] = None,
        snapshot: Any = None,
    ) -> int:
        with self._lock:
            cur = self._conn.execute(
                """
                INSERT INTO merge_log(survivor_id, source_id, reason, snapshot, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    survivor_id,
                    source_id,
                    reason,
                    self._dumps(snapshot),
                    _now_iso(),
                ),
            )
            return int(cur.lastrowid)

    def list_merge_log(self, *, limit: int = 50) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 200))
        with self._lock:
            cur = self._conn.execute(
                "SELECT * FROM merge_log ORDER BY id DESC LIMIT ?",
                (limit,),
            )
            return [self._row_to_dict(r) for r in cur.fetchall()]

    def get_merge_log(self, merge_id: int) -> Optional[dict[str, Any]]:
        with self._lock:
            cur = self._conn.execute(
                "SELECT * FROM merge_log WHERE id = ?",
                (int(merge_id),),
            )
            row = cur.fetchone()
            return self._row_to_dict(row) if row else None

    def add_diary_note(
        self,
        *,
        text: str,
        source: Optional[str] = None,
        emotion: Optional[str] = None,
        meta: Any = None,
        ts: Optional[str] = None,
    ) -> int:
        with self._lock:
            cur = self._conn.execute(
                """
                INSERT INTO diary_notes(ts, text, source, emotion, meta)
                VALUES (?, ?, ?, ?, ?)
                """,
                (to_utc_iso(ts) if ts else _now_iso(), text, source, emotion, self._dumps(meta)),
            )
            return int(cur.lastrowid)

    def list_diary_notes(self, *, limit: int = 20, newest_first: bool = True) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 500))
        order = "DESC" if newest_first else "ASC"
        with self._lock:
            cur = self._conn.execute(
                f"SELECT * FROM diary_notes ORDER BY ts {order}, id {order} LIMIT ?",
                (limit,),
            )
            return [self._row_to_dict(r) for r in cur.fetchall()]

    def delete_diary_note(self, note_id: int) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM diary_notes WHERE id = ?",
                (int(note_id),),
            )
            return cur.rowcount > 0

    def add_journal_entry(
        self,
        *,
        text: str,
        title: Optional[str] = None,
        kind: Optional[str] = None,
        meta: Any = None,
        ts: Optional[str] = None,
    ) -> int:
        with self._lock:
            cur = self._conn.execute(
                """
                INSERT INTO journal_entries(ts, title, text, kind, meta)
                VALUES (?, ?, ?, ?, ?)
                """,
                (to_utc_iso(ts) if ts else _now_iso(), title, text, kind, self._dumps(meta)),
            )
            return int(cur.lastrowid)

    def list_journal_entries(
        self, *, limit: int = 50, newest_first: bool = True
    ) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 1000))
        order = "DESC" if newest_first else "ASC"
        with self._lock:
            cur = self._conn.execute(
                f"SELECT * FROM journal_entries ORDER BY ts {order}, id {order} LIMIT ?",
                (limit,),
            )
            return [self._row_to_dict(r) for r in cur.fetchall()]

    def delete_journal_entry(self, entry_id: int) -> bool:
        with self._lock:
            cur = self._conn.execute(
                "DELETE FROM journal_entries WHERE id = ?",
                (int(entry_id),),
            )
            return cur.rowcount > 0

    def save_wm_snapshot(
        self,
        *,
        user_id: Optional[str],
        content: str,
        meta: Any = None,
        ts: Optional[str] = None,
    ) -> int:
        with self._lock:
            cur = self._conn.execute(
                """
                INSERT INTO working_memory_snapshots(user_id, ts, content, meta)
                VALUES (?, ?, ?, ?)
                """,
                (user_id, to_utc_iso(ts) if ts else _now_iso(), content, self._dumps(meta)),
            )
            return int(cur.lastrowid)

    def latest_wm_snapshot(self, user_id: Optional[str] = None) -> Optional[dict[str, Any]]:
        """
        Latest WM row.
        - user_id is None → global latest (any user)
        - user_id is str (including empty/whitespace) → filter by that id; empty → no match
        """
        with self._lock:
            if user_id is None:
                cur = self._conn.execute(
                    """
                    SELECT * FROM working_memory_snapshots
                    ORDER BY ts DESC, id DESC LIMIT 1
                    """
                )
            else:
                uid = str(user_id).strip()
                if not uid:
                    return None
                cur = self._conn.execute(
                    """
                    SELECT * FROM working_memory_snapshots
                    WHERE user_id = ?
                    ORDER BY ts DESC, id DESC LIMIT 1
                    """,
                    (uid,),
                )
            row = cur.fetchone()
            return self._row_to_dict(row) if row else None

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
        d = dict(row)
        meta = d.get("meta")
        if isinstance(meta, str) and meta.strip():
            try:
                d["meta"] = json.loads(meta)
            except Exception:
                pass
        return d

    def _person_row_to_dict(self, row: sqlite3.Row) -> dict[str, Any]:
        d = self._row_to_dict(row)
        aliases = d.get("aliases")
        if isinstance(aliases, str) and aliases.strip():
            if aliases.strip().startswith("["):
                try:
                    d["aliases"] = json.loads(aliases)
                except Exception:
                    d["aliases"] = [aliases]
            else:
                d["aliases"] = [aliases]
        return d
