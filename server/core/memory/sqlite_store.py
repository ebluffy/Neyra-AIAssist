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
                if version == 3:
                    self._migrate_v3()
                elif version == 4:
                    self._migrate_v4()
                else:
                    self._conn.executescript(sql)
                self._conn.execute(
                    "INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                    (version, _now_iso()),
                )
            # Heal: v3 marked applied but merge_proposals missing (old executescript bug).
            self._ensure_merge_proposals_table()
            self._backfill_person_accounts_from_meta()
            self._backfill_handle_norm()

    def _table_columns(self, table: str) -> set[str]:
        cur = self._conn.execute(f"PRAGMA table_info({table})")
        return {str(r[1]) for r in cur.fetchall()}

    def _migrate_v3(self) -> None:
        cols = self._table_columns("person_accounts")
        if "handle_norm" not in cols:
            self._conn.execute("ALTER TABLE person_accounts ADD COLUMN handle_norm TEXT")
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_person_accounts_handle_norm "
            "ON person_accounts(handle_norm)"
        )
        self._ensure_merge_proposals_table()

    def _migrate_v4(self) -> None:
        cols = self._table_columns("merge_log")
        if "undone_at" not in cols:
            self._conn.execute("ALTER TABLE merge_log ADD COLUMN undone_at TEXT")

    def _ensure_merge_proposals_table(self) -> None:
        self._conn.execute(
            """
            CREATE TABLE IF NOT EXISTS merge_proposals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                person_a TEXT NOT NULL,
                person_b TEXT NOT NULL,
                reason TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                resolved_at TEXT,
                merge_log_id INTEGER
            )
            """
        )
        self._conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_merge_proposals_status ON merge_proposals(status)"
        )

    def backup_to(self, dest: Path) -> None:
        """Consistent SQLite backup (includes WAL) under store lock."""
        dest = Path(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        if dest.exists():
            dest.unlink()
        with self._lock:
            dst = sqlite3.connect(str(dest))
            try:
                self._conn.backup(dst)
            finally:
                dst.close()

    def _backfill_person_accounts_from_meta(self) -> int:
        """One-shot: meta.discord_ids → person_accounts (no wipe required for Discord ids)."""
        n = 0
        try:
            cur = self._conn.execute("SELECT person_id, meta, aliases, display_name FROM people")
            rows = cur.fetchall()
        except Exception:
            return 0
        now = _now_iso()
        for row in rows:
            pid = str(row["person_id"] or "").strip()
            if not pid:
                continue
            meta = row["meta"]
            if isinstance(meta, str) and meta.strip():
                try:
                    meta = json.loads(meta)
                except Exception:
                    meta = {}
            if not isinstance(meta, dict):
                meta = {}
            ids = meta.get("discord_ids") if isinstance(meta.get("discord_ids"), list) else []
            for did in ids:
                puid = str(did or "").strip()
                if not puid:
                    continue
                exists = self._conn.execute(
                    "SELECT 1 FROM person_accounts WHERE platform = ? AND platform_user_id = ?",
                    ("discord", puid),
                ).fetchone()
                if exists:
                    continue
                # Identity only — never invent handle from aliases/display_name.
                self._conn.execute(
                    """
                    INSERT INTO person_accounts(
                        person_id, platform, platform_user_id, handle, handle_norm,
                        display_name, avatar_url, created_at, updated_at
                    ) VALUES (?, 'discord', ?, NULL, NULL, ?, NULL, ?, ?)
                    """,
                    (pid, puid, row["display_name"], now, now),
                )
                n += 1
        if n:
            logger.info("Backfilled %s person_accounts from meta.discord_ids", n)
        return n

    def _backfill_handle_norm(self) -> None:
        """Always Python casefold — SQLite lower() is ASCII-only."""
        try:
            cur = self._conn.execute(
                "SELECT id, handle, handle_norm FROM person_accounts "
                "WHERE handle IS NOT NULL AND handle != ''"
            )
            for r in cur.fetchall():
                h = str(r["handle"] or "")
                norm = h.casefold()
                if str(r["handle_norm"] or "") != norm:
                    self._conn.execute(
                        "UPDATE person_accounts SET handle_norm = ? WHERE id = ?",
                        (norm, int(r["id"])),
                    )
        except Exception as e:
            logger.debug("handle_norm backfill: %s", e)

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
            "merge_proposals",
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
                try:
                    self._conn.execute("DELETE FROM merge_proposals")
                except Exception:
                    pass
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
        # Only real platform handle — never alias/display as handle.
        h = (handle or "").strip() or None
        hnorm = h.casefold() if h else None
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
                        handle_norm = COALESCE(?, handle_norm),
                        display_name = COALESCE(?, display_name),
                        avatar_url = COALESCE(?, avatar_url),
                        updated_at = ?
                    WHERE id = ?
                    """,
                    (
                        person_id,
                        h,
                        hnorm,
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
                        person_id, platform, platform_user_id, handle, handle_norm,
                        display_name, avatar_url, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (person_id, plat, puid, h, hnorm, display_name, avatar_url, now, now),
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

    def find_person_ids_by_handle_norm(self, handle: str) -> list[str]:
        """Exact handle_norm match only (never display_name). May return multiple people."""
        h = (handle or "").strip().casefold()
        if not h:
            return []
        with self._lock:
            cur = self._conn.execute(
                """
                SELECT DISTINCT person_id FROM person_accounts
                WHERE handle_norm = ?
                """,
                (h,),
            )
            return [str(r["person_id"]) for r in cur.fetchall() if r["person_id"]]

    def list_all_accounts(self) -> list[dict[str, Any]]:
        with self._lock:
            cur = self._conn.execute("SELECT * FROM person_accounts ORDER BY id ASC")
            return [self._row_to_dict(r) for r in cur.fetchall()]

    def add_merge_proposal(
        self,
        *,
        person_a: str,
        person_b: str,
        reason: Optional[str] = None,
    ) -> int:
        a = (person_a or "").strip()
        b = (person_b or "").strip()
        if not a or not b or a == b:
            raise ValueError("two distinct person_ids required")
        with self._lock:
            cur = self._conn.execute(
                """
                SELECT id FROM merge_proposals
                WHERE status = 'pending'
                  AND ((person_a = ? AND person_b = ?) OR (person_a = ? AND person_b = ?))
                LIMIT 1
                """,
                (a, b, b, a),
            )
            existing = cur.fetchone()
            if existing:
                return int(existing["id"])
            cur = self._conn.execute(
                """
                INSERT INTO merge_proposals(person_a, person_b, reason, status, created_at)
                VALUES (?, ?, ?, 'pending', ?)
                """,
                (a, b, reason, _now_iso()),
            )
            return int(cur.lastrowid)

    def list_merge_proposals(self, *, status: str = "pending", limit: int = 50) -> list[dict[str, Any]]:
        limit = max(1, min(int(limit), 200))
        with self._lock:
            cur = self._conn.execute(
                """
                SELECT * FROM merge_proposals
                WHERE status = ?
                ORDER BY id DESC LIMIT ?
                """,
                (status, limit),
            )
            return [self._row_to_dict(r) for r in cur.fetchall()]

    def get_merge_proposal(self, proposal_id: int) -> Optional[dict[str, Any]]:
        with self._lock:
            cur = self._conn.execute(
                "SELECT * FROM merge_proposals WHERE id = ?",
                (int(proposal_id),),
            )
            row = cur.fetchone()
            return self._row_to_dict(row) if row else None

    def resolve_merge_proposal(
        self,
        proposal_id: int,
        *,
        status: str,
        merge_log_id: Optional[int] = None,
    ) -> None:
        now = _now_iso()
        with self._lock:
            self._conn.execute(
                """
                UPDATE merge_proposals
                SET status = ?, resolved_at = ?, merge_log_id = COALESCE(?, merge_log_id)
                WHERE id = ?
                """,
                (status, now, merge_log_id, int(proposal_id)),
            )

    def merge_people_atomic(
        self,
        *,
        survivor_id: str,
        source_id: str,
        reason: str,
        proposal_id: Optional[int] = None,
    ) -> tuple[int, dict[str, Any]]:
        """Single transaction: snapshot all fact ids, move rows, rewrite proposals, log."""
        now = _now_iso()
        with self._lock:
            try:
                self._conn.execute("BEGIN IMMEDIATE")
                s_cur = self._conn.execute(
                    "SELECT * FROM people WHERE person_id = ?", (survivor_id,)
                )
                s_row = s_cur.fetchone()
                o_cur = self._conn.execute(
                    "SELECT * FROM people WHERE person_id = ?", (source_id,)
                )
                o_row = o_cur.fetchone()
                if s_row is None:
                    raise KeyError(survivor_id)
                if o_row is None:
                    raise KeyError(source_id)
                s_dict = self._person_row_to_dict(s_row)
                o_dict = self._person_row_to_dict(o_row)

                acc_cur = self._conn.execute(
                    "SELECT * FROM person_accounts WHERE person_id = ? ORDER BY id ASC",
                    (source_id,),
                )
                accounts = [self._row_to_dict(r) for r in acc_cur.fetchall()]
                # All fact ids (no LIMIT) — texts capped for snapshot size only.
                id_cur = self._conn.execute(
                    "SELECT id FROM person_facts WHERE person_id = ? ORDER BY id ASC",
                    (source_id,),
                )
                fact_ids = [int(r["id"]) for r in id_cur.fetchall()]
                fact_cur = self._conn.execute(
                    """
                    SELECT * FROM person_facts WHERE person_id = ?
                    ORDER BY id DESC LIMIT 50
                    """,
                    (source_id,),
                )
                facts_sample = [self._row_to_dict(r) for r in fact_cur.fetchall()]

                def _aliases(raw: Any) -> list[str]:
                    if isinstance(raw, list):
                        return [str(x).strip() for x in raw if str(x).strip()]
                    if isinstance(raw, str) and raw.strip().startswith("["):
                        try:
                            parsed = json.loads(raw)
                            if isinstance(parsed, list):
                                return [str(x).strip() for x in parsed if str(x).strip()]
                        except Exception:
                            pass
                    return []

                s_aliases = _aliases(s_dict.get("aliases"))
                o_aliases = _aliases(o_dict.get("aliases"))
                merged_aliases: list[str] = []
                for a in s_aliases + o_aliases:
                    if a and a not in merged_aliases:
                        merged_aliases.append(a)
                survivor_display = str(s_dict.get("display_name") or survivor_id)
                survivor_meta = (
                    s_dict.get("meta") if isinstance(s_dict.get("meta"), dict) else {}
                )

                snapshot = {
                    "person": {
                        "id": source_id,
                        "display_name": o_dict.get("display_name"),
                        "aliases": o_aliases or [source_id],
                        "names": o_aliases or [source_id],
                        "meta": o_dict.get("meta") if isinstance(o_dict.get("meta"), dict) else {},
                    },
                    "facts": facts_sample,
                    "fact_ids": fact_ids,
                    "accounts": accounts,
                    "survivor_before": {
                        "display_name": survivor_display,
                        "aliases": s_aliases or [survivor_id],
                        "meta": survivor_meta,
                    },
                }

                # Move everything — do not DELETE duplicate fact texts (undo must restore).
                self._conn.execute(
                    "UPDATE person_accounts SET person_id = ?, updated_at = ? WHERE person_id = ?",
                    (survivor_id, now, source_id),
                )
                self._conn.execute(
                    "UPDATE person_facts SET person_id = ? WHERE person_id = ?",
                    (survivor_id, source_id),
                )
                self._conn.execute(
                    """
                    UPDATE people
                    SET display_name = ?, aliases = ?, updated_at = ?, meta = ?
                    WHERE person_id = ?
                    """,
                    (
                        survivor_display,
                        self._dumps(merged_aliases or [survivor_id]),
                        now,
                        self._dumps(survivor_meta),
                        survivor_id,
                    ),
                )
                self._conn.execute("DELETE FROM people WHERE person_id = ?", (source_id,))
                cur = self._conn.execute(
                    """
                    INSERT INTO merge_log(survivor_id, source_id, reason, snapshot, created_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (survivor_id, source_id, reason, self._dumps(snapshot), now),
                )
                log_id = int(cur.lastrowid)

                # Mark applied proposal first so rewrite/stale cannot collapse it.
                if proposal_id is not None:
                    self._conn.execute(
                        """
                        UPDATE merge_proposals
                        SET status = 'applied', resolved_at = ?, merge_log_id = ?
                        WHERE id = ? AND status = 'pending'
                        """,
                        (now, log_id, int(proposal_id)),
                    )

                # Rewrite remaining pending proposals that pointed at source → survivor.
                self._conn.execute(
                    """
                    UPDATE merge_proposals SET person_a = ?
                    WHERE status = 'pending' AND person_a = ?
                    """,
                    (survivor_id, source_id),
                )
                self._conn.execute(
                    """
                    UPDATE merge_proposals SET person_b = ?
                    WHERE status = 'pending' AND person_b = ?
                    """,
                    (survivor_id, source_id),
                )
                self._conn.execute(
                    """
                    UPDATE merge_proposals
                    SET status = 'stale', resolved_at = ?
                    WHERE status = 'pending' AND person_a = person_b
                    """,
                    (now,),
                )

                self._conn.execute("COMMIT")
                stats = {
                    "accounts_moved": len(accounts),
                    "facts_moved": len(fact_ids),
                    "merge_log_id": log_id,
                    "survivor_id": survivor_id,
                    "source_id": source_id,
                }
                return log_id, stats
            except Exception:
                try:
                    self._conn.execute("ROLLBACK")
                except Exception:
                    pass
                raise

    def undo_merge_atomic(self, merge_id: int) -> dict[str, Any]:
        """Restore source from snapshot: move facts back, restore survivor fields."""
        with self._lock:
            cur = self._conn.execute("SELECT * FROM merge_log WHERE id = ?", (int(merge_id),))
            row = cur.fetchone()
            if not row:
                raise KeyError(merge_id)
            log = self._row_to_dict(row)
            if log.get("undone_at"):
                raise ValueError("merge_already_undone")
            snap = log.get("snapshot")
            if isinstance(snap, str) and snap.strip():
                try:
                    snap = json.loads(snap)
                except Exception:
                    snap = None
            if not isinstance(snap, dict):
                raise ValueError("merge snapshot missing")
            person = snap.get("person") if isinstance(snap.get("person"), dict) else {}
            source_id = str(log.get("source_id") or person.get("id") or "").strip()
            survivor_id = str(log.get("survivor_id") or "").strip()
            if not source_id or not survivor_id:
                raise ValueError("source_id/survivor_id missing in merge log")
            fact_ids = [
                int(x)
                for x in (snap.get("fact_ids") or [])
                if x is not None
            ]
            survivor_before = (
                snap.get("survivor_before")
                if isinstance(snap.get("survivor_before"), dict)
                else {}
            )
            now = _now_iso()
            try:
                self._conn.execute("BEGIN IMMEDIATE")
                # Accounts from snapshot must still belong to survivor (or be free).
                for acc in snap.get("accounts") or []:
                    if not isinstance(acc, dict):
                        continue
                    plat = str(acc.get("platform") or "").strip().lower()
                    puid = str(acc.get("platform_user_id") or "").strip()
                    if not plat or not puid:
                        continue
                    own = self._conn.execute(
                        "SELECT person_id FROM person_accounts "
                        "WHERE platform = ? AND platform_user_id = ?",
                        (plat, puid),
                    ).fetchone()
                    if own is not None and str(own["person_id"]) not in (survivor_id, source_id):
                        raise ValueError(
                            f"account {plat}:{puid} reassigned away from survivor; cannot undo"
                        )

                self._conn.execute(
                    """
                    INSERT OR REPLACE INTO people(
                        person_id, display_name, aliases, created_at, updated_at, meta
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        source_id,
                        person.get("display_name") or source_id,
                        self._dumps(person.get("aliases") or person.get("names") or [source_id]),
                        now,
                        now,
                        self._dumps(person.get("meta") or {}),
                    ),
                )
                if fact_ids:
                    placeholders = ",".join("?" * len(fact_ids))
                    self._conn.execute(
                        f"UPDATE person_facts SET person_id = ? WHERE id IN ({placeholders})",
                        (source_id, *fact_ids),
                    )
                else:
                    # Legacy snapshots without fact_ids: re-insert (may dup) — prefer move.
                    for fact in snap.get("facts") or []:
                        if not isinstance(fact, dict):
                            continue
                        fid = fact.get("id")
                        if fid is not None:
                            self._conn.execute(
                                "UPDATE person_facts SET person_id = ? WHERE id = ?",
                                (source_id, int(fid)),
                            )

                accounts_not_restored: list[str] = []
                for acc in snap.get("accounts") or []:
                    if not isinstance(acc, dict):
                        continue
                    plat = str(acc.get("platform") or "").strip().lower()
                    puid = str(acc.get("platform_user_id") or "").strip()
                    if not plat or not puid:
                        continue
                    h = str(acc.get("handle") or "").strip() or None
                    cur_acc = self._conn.execute(
                        """
                        UPDATE person_accounts
                        SET person_id = ?, handle = ?, handle_norm = ?,
                            display_name = COALESCE(?, display_name),
                            avatar_url = COALESCE(?, avatar_url),
                            updated_at = ?
                        WHERE platform = ? AND platform_user_id = ?
                        """,
                        (
                            source_id,
                            h,
                            h.casefold() if h else None,
                            acc.get("display_name"),
                            acc.get("avatar_url"),
                            now,
                            plat,
                            puid,
                        ),
                    )
                    if cur_acc.rowcount == 0:
                        accounts_not_restored.append(f"{plat}:{puid}")

                # Survivor: strip only aliases that came from source (keep post-merge edits).
                def _al(raw: Any) -> list[str]:
                    if isinstance(raw, list):
                        return [str(x).strip() for x in raw if str(x).strip()]
                    if isinstance(raw, str) and raw.strip().startswith("["):
                        try:
                            parsed = json.loads(raw)
                            if isinstance(parsed, list):
                                return [str(x).strip() for x in parsed if str(x).strip()]
                        except Exception:
                            pass
                    if isinstance(raw, str) and raw.strip():
                        return [raw.strip()]
                    return []

                surv_row = self._conn.execute(
                    "SELECT aliases FROM people WHERE person_id = ?", (survivor_id,)
                ).fetchone()
                if surv_row is not None:
                    before_set = {a.casefold() for a in _al(survivor_before.get("aliases"))}
                    source_set = {
                        a.casefold()
                        for a in _al(person.get("aliases") or person.get("names"))
                    }
                    current = _al(surv_row["aliases"])
                    kept = [
                        a
                        for a in current
                        if a.casefold() in before_set or a.casefold() not in source_set
                    ]
                    if not kept:
                        kept = list(_al(survivor_before.get("aliases"))) or [survivor_id]
                    self._conn.execute(
                        "UPDATE people SET aliases = ?, updated_at = ? WHERE person_id = ?",
                        (self._dumps(kept), now, survivor_id),
                    )

                try:
                    self._conn.execute(
                        "UPDATE merge_log SET undone_at = ? WHERE id = ?",
                        (now, int(merge_id)),
                    )
                except sqlite3.OperationalError:
                    pass
                self._conn.execute(
                    """
                    UPDATE merge_proposals
                    SET status = 'undone', resolved_at = ?
                    WHERE merge_log_id = ? AND status = 'applied'
                    """,
                    (now, int(merge_id)),
                )
                self._conn.execute("COMMIT")
                return {
                    "restored_id": source_id,
                    "survivor_id": survivor_id,
                    "merge_log_id": int(merge_id),
                    "accounts_not_restored": accounts_not_restored,
                }
            except Exception:
                try:
                    self._conn.execute("ROLLBACK")
                except Exception:
                    pass
                raise

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
