"""MemoryHub — single facade for durable memory (Phase 1A)."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from typing import Any, Optional

from core.runtime.event_bus import (
    MEMORY_CHAT_LOG_APPEND,
    MEMORY_JOURNAL_UPDATED,
    MEMORY_LONG_TERM_WRITE,
    MEMORY_WORKING_MEMORY_UPDATED,
    CoreEvent,
)
from core.memory.semantic_index import ChromaSemanticIndex, SemanticIndex
from core.memory.sqlite_store import SqliteStore
from core.runtime.timeutil import configure_timezone, now_storage_iso, to_utc_iso

logger = logging.getLogger("neyra.memory.hub")


def _now_iso() -> str:
    """UTC ISO for Hub/SQLite ts (stable chronological TEXT order)."""
    return now_storage_iso()


class MemoryHub:
    """
    Source of truth for chat_log + structured layers in SQLite.
    Semantic index via adapter. Once attached, Hub SQLite is the only durable store for
    people/diary/journal/WM — no JSON/JSONL/MD writes or fallback reads.
    """

    def __init__(
        self,
        config: dict[str, Any],
        *,
        long_memory: Any = None,
        event_bus: Any = None,
        semantic: Optional[SemanticIndex] = None,
    ):
        mem = config.get("memory") if isinstance(config.get("memory"), dict) else {}
        self.config = config
        self.mem_cfg = mem
        self.event_bus = event_bus
        self._long_memory = long_memory
        path = str(mem.get("sqlite_path") or "./data/memory/neyra_memory.db")
        self.sqlite = SqliteStore(path)
        self.rag_write_mode = str(mem.get("rag_write_mode") or "important_only").strip().lower()
        if self.rag_write_mode not in {"off", "digest", "important_only", "legacy_dialog"}:
            logger.warning("Unknown rag_write_mode=%r — using important_only", self.rag_write_mode)
            self.rag_write_mode = "important_only"
        sys_cfg = config.get("system") if isinstance(config.get("system"), dict) else {}
        tz_name = str(sys_cfg.get("timezone") or mem.get("timezone") or "").strip() or None
        self.timezone_name = tz_name
        active_tz = configure_timezone(tz_name)
        if semantic is not None:
            self.semantic: SemanticIndex = semantic
        elif long_memory is not None:
            self.semantic = ChromaSemanticIndex(long_memory)
        else:
            self.semantic = ChromaSemanticIndex(_NullLTM())
        logger.info(
            "MemoryHub ready | sqlite=%s | schema_v%s | rag_write_mode=%s | tz=%s",
            path,
            self.sqlite.schema_version(),
            self.rag_write_mode,
            getattr(active_tz, "key", None) or str(active_tz),
        )

    def close(self) -> None:
        self.sqlite.close()

    def new_turn_id(self) -> str:
        return str(uuid.uuid4())

    def allows_raw_dialog_embed(self) -> bool:
        """
        Raw full-chat Chroma embeds are forbidden for off/digest/important_only.
        Escape hatch: rag_write_mode=legacy_dialog (migration only).
        """
        return self.rag_write_mode == "legacy_dialog"

    def append_chat(
        self,
        *,
        role: str,
        text: str,
        user_id: Optional[str] = None,
        display_name: Optional[str] = None,
        channel_id: Optional[str] = None,
        source: Optional[str] = None,
        turn_id: Optional[str] = None,
        latency_ms: Optional[float] = None,
        emotion: Optional[str] = None,
        mood: Optional[str] = None,
        meta: Optional[dict[str, Any]] = None,
        ts: Optional[str] = None,
        publish_event: bool = True,
    ) -> int:
        ids = self.append_chat_batch(
            [
                {
                    "role": role,
                    "text": text,
                    "user_id": user_id,
                    "display_name": display_name,
                    "channel_id": channel_id,
                    "source": source,
                    "turn_id": turn_id,
                    "latency_ms": latency_ms,
                    "emotion": emotion,
                    "mood": mood,
                    "meta": meta,
                    "ts": ts,
                }
            ],
            publish_event=publish_event,
        )
        return ids[0] if ids else 0

    def append_chat_batch(
        self,
        rows: list[dict[str, Any]],
        *,
        publish_event: bool = True,
    ) -> list[int]:
        prepared: list[dict[str, Any]] = []
        for row in rows:
            prepared.append(
                {
                    **row,
                    "ts": to_utc_iso(row.get("ts")) if row.get("ts") else _now_iso(),
                    "text": str(row.get("text") or ""),
                    "role": str(row.get("role") or ""),
                }
            )
        ids = self.sqlite.append_chat_rows(prepared)
        if publish_event and self.event_bus is not None and ids:
            try:
                first = prepared[0]
                self.event_bus.publish(
                    CoreEvent(
                        MEMORY_CHAT_LOG_APPEND,
                        "core.memory.hub",
                        {
                            "ids": ids,
                            "count": len(ids),
                            "turn_id": first.get("turn_id"),
                            "user_id": first.get("user_id"),
                            "channel_id": first.get("channel_id"),
                            "roles": [r.get("role") for r in prepared],
                        },
                    )
                )
            except Exception as e:
                logger.debug("chat_log_append event failed: %s", e)
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
        return self.sqlite.list_chat(
            user_id=user_id,
            channel_id=channel_id,
            limit=limit,
            offset=offset,
            newest_first=newest_first,
        )

    def search_semantic(
        self,
        query: str,
        n_results: Optional[int] = None,
        *,
        user_id: Optional[str] = None,
    ) -> list[str]:
        if not getattr(self.semantic, "rag_enabled", True):
            return []
        return self.semantic.search(query, n_results=n_results, user_id=user_id)

    def remember_knowledge(
        self, text: str, metadata: Optional[dict[str, Any]] = None
    ) -> tuple[bool, str]:
        if self.rag_write_mode == "off":
            return False, "rag_write_mode=off"
        meta = dict(metadata or {})
        if "type" not in meta:
            meta["type"] = "knowledge"
        ok, info = self.semantic.add_knowledge(text, meta)
        if ok and self.event_bus is not None:
            try:
                self.event_bus.publish(
                    CoreEvent(
                        MEMORY_LONG_TERM_WRITE,
                        "core.memory.hub",
                        {"kind": "knowledge", "id": info, "rag_write_mode": self.rag_write_mode},
                    )
                )
            except Exception as e:
                logger.debug("long_term_write event failed: %s", e)
        return ok, info

    def save_dialog_semantic(
        self, user_msg: str, assistant_msg: str, metadata: Optional[dict[str, Any]] = None
    ) -> bool:
        """Raw dialog embed — only when rag_write_mode=legacy_dialog."""
        if not self.allows_raw_dialog_embed():
            logger.debug(
                "Skip raw dialog Chroma embed (rag_write_mode=%s)", self.rag_write_mode
            )
            return False
        if self._long_memory is None:
            return False
        self._long_memory.save(user_msg, assistant_msg, metadata)
        return True

    # ── people / diary / journal / WM ─────────────────────────────────────────

    def upsert_person(
        self,
        person_id: str,
        *,
        display_name: Optional[str] = None,
        aliases: Optional[list[str]] = None,
        meta: Optional[dict[str, Any]] = None,
    ) -> None:
        self.sqlite.upsert_person(
            person_id=person_id,
            display_name=display_name,
            aliases=aliases,
            meta=meta,
        )

    def add_person_fact(
        self,
        person_id: str,
        fact: str,
        *,
        emotion_note: Optional[str] = None,
        source: Optional[str] = None,
        meta: Optional[dict[str, Any]] = None,
        person_meta: Optional[dict[str, Any]] = None,
        aliases: Optional[list[str]] = None,
        display_name: Optional[str] = None,
        created_at: Optional[str] = None,
    ) -> int:
        if person_meta or aliases or display_name:
            self.upsert_person(
                person_id,
                display_name=display_name,
                aliases=aliases,
                meta=person_meta,
            )
        else:
            # ensure row exists for FK
            if self.sqlite.get_person(person_id) is None:
                self.upsert_person(person_id, display_name=display_name or person_id)
        return self.sqlite.add_person_fact(
            person_id=person_id,
            fact=fact,
            emotion_note=emotion_note,
            source=source,
            meta=meta,
            created_at=created_at,
        )

    def get_person(self, person_id: str) -> Optional[dict[str, Any]]:
        return self.sqlite.get_person(person_id)

    def list_person_facts(self, person_id: str, limit: int = 20) -> list[dict[str, Any]]:
        return self.sqlite.list_person_facts(person_id, limit=limit)

    def add_diary_note(
        self,
        text: str,
        *,
        source: Optional[str] = None,
        emotion: Optional[str] = None,
        meta: Optional[dict[str, Any]] = None,
        ts: Optional[str] = None,
    ) -> int:
        return self.sqlite.add_diary_note(
            text=text, source=source, emotion=emotion, meta=meta, ts=ts
        )

    def list_diary_notes(self, *, limit: int = 20, newest_first: bool = True) -> list[dict[str, Any]]:
        return self.sqlite.list_diary_notes(limit=limit, newest_first=newest_first)

    def add_journal_entry(
        self,
        text: str,
        *,
        title: Optional[str] = None,
        kind: Optional[str] = None,
        meta: Optional[dict[str, Any]] = None,
        ts: Optional[str] = None,
        publish_event: bool = True,
    ) -> int:
        row_id = self.sqlite.add_journal_entry(
            text=text, title=title, kind=kind, meta=meta, ts=ts
        )
        if publish_event and self.event_bus is not None:
            try:
                self.event_bus.publish(
                    CoreEvent(
                        MEMORY_JOURNAL_UPDATED,
                        "core.memory.hub",
                        {"id": row_id, "kind": kind, "title": title},
                    )
                )
            except Exception as e:
                logger.debug("journal_updated event failed: %s", e)
        return row_id

    def list_journal_entries(
        self, *, limit: int = 50, newest_first: bool = True
    ) -> list[dict[str, Any]]:
        return self.sqlite.list_journal_entries(limit=limit, newest_first=newest_first)

    def save_wm_snapshot(
        self,
        content: str,
        *,
        user_id: Optional[str] = None,
        meta: Optional[dict[str, Any]] = None,
        ts: Optional[str] = None,
        publish_event: bool = True,
    ) -> int:
        row_id = self.sqlite.save_wm_snapshot(
            user_id=user_id, content=content, meta=meta, ts=ts
        )
        if publish_event and self.event_bus is not None:
            try:
                self.event_bus.publish(
                    CoreEvent(
                        MEMORY_WORKING_MEMORY_UPDATED,
                        "core.memory.hub",
                        {"id": row_id, "user_id": user_id, "chars": len(content or "")},
                    )
                )
            except Exception as e:
                logger.debug("wm_updated event failed: %s", e)
        return row_id

    @staticmethod
    def _aliases_list(raw: Any) -> list[str]:
        if raw is None:
            return []
        if isinstance(raw, list):
            return [str(x).strip() for x in raw if str(x).strip()]
        if isinstance(raw, str):
            s = raw.strip()
            if not s:
                return []
            if s.startswith("["):
                try:
                    parsed = json.loads(s)
                    if isinstance(parsed, list):
                        return [str(x).strip() for x in parsed if str(x).strip()]
                except Exception:
                    pass
            return [s]
        return [str(raw).strip()] if str(raw).strip() else []

    def _person_as_legacy_dict(self, row: dict[str, Any]) -> dict[str, Any]:
        """Normalize SQLite people row to PeopleDB-shaped dict (id/names/discord_ids)."""
        pid = str(row.get("person_id") or "").strip()
        aliases = self._aliases_list(row.get("aliases"))
        meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
        if not aliases and isinstance(meta.get("names"), list):
            aliases = [str(x).strip() for x in meta["names"] if str(x).strip()]
        display = str(row.get("display_name") or "").strip()
        names = aliases or ([display] if display else ([pid] if pid else []))
        discord_ids: list[str] = []
        if isinstance(meta.get("discord_ids"), list):
            discord_ids = [str(x).strip() for x in meta["discord_ids"] if str(x).strip()]
        return {
            "id": pid,
            "names": names,
            "discord_ids": discord_ids,
            "static_facts": meta.get("static_facts") if isinstance(meta.get("static_facts"), dict) else {},
            "dynamic_facts": list(meta.get("dynamic_facts") or [])
            if isinstance(meta.get("dynamic_facts"), list)
            else [],
            "last_seen": row.get("updated_at") or meta.get("last_seen"),
            "meta": meta,
        }

    def list_people(self) -> list[dict[str, Any]]:
        return [self._person_as_legacy_dict(r) for r in self.sqlite.list_people()]

    def find_person(self, identifier: str, discord_id: Optional[str] = None) -> Optional[dict[str, Any]]:
        """Identity lookup: SQLite only (Hub is the sole people store once attached)."""
        ident = (identifier or "").strip()
        ident_lower = ident.lower()
        discord = (discord_id or "").strip() or None

        for person in self.list_people():
            if discord and discord in (person.get("discord_ids") or []):
                return person
            if not ident_lower:
                continue
            if str(person.get("id") or "").lower() == ident_lower:
                return person
            names_lower = [str(n).lower() for n in (person.get("names") or [])]
            if ident_lower in names_lower:
                return person
            if any(ident_lower in n or n in ident_lower for n in names_lower if n):
                return person
        return None

    def get_all_names_map(self) -> dict[str, str]:
        """Map lowercased name/alias → person_id (SQLite only)."""
        result: dict[str, str] = {}
        for person in self.list_people():
            pid = str(person.get("id") or "").strip()
            if not pid:
                continue
            result[pid.lower()] = pid
            for name in person.get("names") or []:
                key = str(name).strip().lower()
                if key:
                    result[key] = pid
        return result

    def get_person_summary(self, person_id: str) -> str:
        """Prompt dossier from SQLite person+facts; legacy PeopleDB only if no Hub row."""
        pid = (person_id or "").strip()
        if not pid:
            return ""
        person = self.sqlite.get_person(pid)
        if person:
            names = person.get("aliases") or []
            if isinstance(names, str):
                names = [names]
            if not isinstance(names, list):
                names = []
            title = person.get("display_name") or (names[0] if names else pid)
            lines = [f"Досье на {title}:"]
            meta = person.get("meta")
            if isinstance(meta, str) and meta.strip():
                try:
                    meta = json.loads(meta)
                except Exception:
                    meta = {}
            if not isinstance(meta, dict):
                meta = {}
            discord_ids = meta.get("discord_ids")
            if isinstance(discord_ids, list) and discord_ids:
                raw_id = str(discord_ids[0] or "").strip()
                if raw_id.isdigit() and 5 <= len(raw_id) <= 32:
                    lines.append(f"  Discord пинг (ИСПОЛЬЗУЙ ЧТОБЫ ТЕГНУТЬ ЕГО): <@{raw_id}>")
            static = meta.get("static_facts") if isinstance(meta.get("static_facts"), dict) else {}
            for key, val in static.items():
                lines.append(f"  {key}: {val}")
            facts = self.sqlite.list_person_facts(pid, limit=5)
            if facts:
                lines.append("  Новые факты:")
                for f in reversed(facts):
                    fact_line = str(f.get("fact") or "")
                    emo = str(f.get("emotion_note") or "").strip()
                    ts = str(f.get("created_at") or "")[:10]
                    if emo:
                        lines.append(
                            f"    [{ts}] {fact_line} (настроение Нейры при записи: {emo})"
                        )
                    else:
                        lines.append(f"    [{ts}] {fact_line}")
            return "\n".join(lines)
        return ""

    def diary_recent_text(self, limit: int = 10) -> str:
        """Diary for prompt: formatted directly from SQLite rows (Hub is the sole diary store)."""
        lim = max(1, int(limit))
        # Fetch extra so filtering session_archive (cross-user / ops) still fills the prompt budget.
        rows = self.list_diary_notes(limit=max(lim * 3, lim), newest_first=True)
        if not rows:
            return ""
        rows = list(reversed(rows))
        lines: list[str] = []
        for e in rows:
            ts = e.get("ts") or ""
            src = str(e.get("source") or "manual").strip()
            # session_archive notes are process-global; keep out of PRE-CONTEXT / brain diary block.
            if src == "session_archive":
                continue
            txt = str(e.get("text") or "").strip()
            if not txt:
                continue
            emo = str(e.get("emotion") or "").strip()
            if not emo and isinstance(e.get("meta"), dict):
                emo = str(e["meta"].get("emotion") or e["meta"].get("assistant_mood") or "").strip()
            suf = f" | настр.: {emo}" if emo else ""
            lines.append(f"[{ts} | {src}{suf}] {txt}")
            if len(lines) >= lim:
                break
        return "\n".join(lines)

    def working_memory_for_prompt(
        self, internal_user_id: str, *, root: Any = None
    ) -> str:
        """WM snippet for prompt: latest SQLite snapshot only (Hub is the sole WM store)."""
        from core.memory import working_memory as wm

        snap = self.sqlite.latest_wm_snapshot(user_id=internal_user_id)
        if snap and str(snap.get("content") or "").strip():
            raw = str(snap["content"]).strip()
            cap = max(400, int(wm.wm_config(self.config).get("max_chars_in_prompt", 3500)))
            if len(raw) <= cap:
                return raw
            tail = raw[-cap:]
            cut = tail.find("\n")
            if cut > 0 and cut < 400:
                tail = tail[cut + 1 :]
            return "[…фрагмент рабочей памяти (SQLite), хвост…]\n" + tail.strip()
        return ""

    def stats(self) -> dict[str, Any]:
        return {
            "sqlite_path": str(self.sqlite.path),
            "schema_version": self.sqlite.schema_version(),
            "rag_write_mode": self.rag_write_mode,
            "allows_raw_dialog_embed": self.allows_raw_dialog_embed(),
            "chat_log": self.sqlite.count_table("chat_log"),
            "people": self.sqlite.count_table("people"),
            "person_facts": self.sqlite.count_table("person_facts"),
            "diary_notes": self.sqlite.count_table("diary_notes"),
            "journal_entries": self.sqlite.count_table("journal_entries"),
            "working_memory_snapshots": self.sqlite.count_table("working_memory_snapshots"),
            "semantic_outbox": self.sqlite.count_table("semantic_outbox"),
            "chroma_records": self.semantic.count(),
            "rag_enabled": bool(getattr(self.semantic, "rag_enabled", True)),
        }


class _NullLTM:
    rag_enabled = False

    def search(self, query: str, n_results: Optional[int] = None) -> list[str]:
        return []

    def count(self) -> int:
        return 0

    def add_knowledge(self, text: str, metadata: Optional[dict] = None) -> tuple[bool, str]:
        return False, "no long_memory"

    def save(self, user_msg: str, assistant_msg: str, metadata: Optional[dict] = None) -> None:
        return None
