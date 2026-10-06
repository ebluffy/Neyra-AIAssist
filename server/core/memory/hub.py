"""MemoryHub — single facade for durable memory (Phase 1A)."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from pathlib import Path
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
        from core.runtime.paths import resolve_memory_path

        raw = str(mem.get("sqlite_path") or "./data/memory/neyra_memory.db").strip()
        path = raw if Path(raw).is_absolute() else str(
            resolve_memory_path(Path.cwd(), config, raw, "./data/memory/neyra_memory.db")
        )
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

    def delete_person_fact(self, person_id: str, fact_id: int) -> bool:
        return self.sqlite.delete_person_fact(person_id, fact_id)

    def delete_person(self, person_id: str) -> bool:
        return self.sqlite.delete_person(person_id)

    def save_person_dossier(
        self,
        *,
        person_id: str,
        names: list[str] | None = None,
        discord_ids: list[str] | None = None,
        profile: dict[str, Any] | None = None,
        accounts: list[dict[str, Any]] | None = None,
        create: bool = False,
    ) -> dict[str, Any]:
        """Create/update person card (aliases + accounts). ``profile`` ignored (Memory v2)."""
        from core.memory.person_profile import split_static_facts

        pid = (person_id or "").strip()
        if not pid:
            raise ValueError("person_id required")
        existing = self.sqlite.get_person(pid)
        if existing is None and not create:
            raise KeyError(pid)
        meta: dict[str, Any] = {}
        if existing and isinstance(existing.get("meta"), dict):
            meta = dict(existing["meta"])
        leftovers: list[str] = []
        if "static_facts" in meta:
            _, leftovers = split_static_facts(meta.pop("static_facts", None))
        if names is not None:
            clean_names = [str(n).strip() for n in names if str(n).strip()]
            meta["names"] = clean_names
        else:
            clean_names = list(meta.get("names") or [])
            if not clean_names:
                aliases = existing.get("aliases") if existing else None
                if isinstance(aliases, list):
                    clean_names = [str(n).strip() for n in aliases if str(n).strip()]
        display = clean_names[0] if clean_names else pid
        self.upsert_person(pid, display_name=display, aliases=clean_names or [pid], meta=meta)
        for did in discord_ids or []:
            d = str(did or "").strip()
            if d:
                # Never store alias/display as handle — only real platform handle via accounts[].
                self.sqlite.upsert_person_account(
                    person_id=pid,
                    platform="discord",
                    platform_user_id=d,
                    handle=None,
                )
        for acc in accounts or []:
            if not isinstance(acc, dict):
                continue
            plat = str(acc.get("platform") or "").strip()
            puid = str(acc.get("platform_user_id") or "").strip()
            if plat and puid:
                self.sqlite.upsert_person_account(
                    person_id=pid,
                    platform=plat,
                    platform_user_id=puid,
                    handle=str(acc.get("handle") or "").strip() or None,
                    display_name=str(acc.get("display_name") or "").strip() or None,
                    avatar_url=str(acc.get("avatar_url") or "").strip() or None,
                )
        for line in leftovers:
            # Dedup against recent facts
            existing = {
                str(f.get("fact") or "").strip()
                for f in self.sqlite.list_person_facts(pid, limit=50)
            }
            if line not in existing:
                self.sqlite.add_person_fact(person_id=pid, fact=line, source="profile_migrate")
        # ``profile`` ignored in Memory v2 (no анкетные fields).
        _ = profile
        row = self.sqlite.get_person(pid)
        return self._person_as_legacy_dict(row) if row else {"id": pid}

    def ensure_person_for_account(
        self,
        *,
        platform: str,
        platform_user_id: str,
        handle: Optional[str] = None,
        display_name: Optional[str] = None,
        avatar_url: Optional[str] = None,
    ) -> dict[str, Any]:
        """Resolve or create person by platform_user_id only (never auto-bind by nick)."""
        from core.runtime.identity import UnifiedIdentityMapper

        plat = (platform or "unknown").strip().lower()
        puid = (platform_user_id or "").strip()
        if not puid:
            raise ValueError("platform_user_id required")
        h = (handle or "").strip() or None
        acc = self.sqlite.get_account(plat, puid)
        if acc:
            pid = str(acc.get("person_id") or "").strip()
            self.sqlite.upsert_person_account(
                person_id=pid,
                platform=plat,
                platform_user_id=puid,
                handle=h,
                display_name=display_name,
                avatar_url=avatar_url,
            )
            row = self.sqlite.get_person(pid)
            return self._person_as_legacy_dict(row) if row else {"id": pid}

        # Same handle elsewhere → merge candidate only (do NOT bind accounts).
        if h:
            others = [
                oid
                for oid in self.sqlite.find_person_ids_by_handle_norm(h)
                if oid
            ]
            for oid in others:
                try:
                    self.sqlite.add_merge_proposal(
                        person_a=oid,
                        person_b=UnifiedIdentityMapper.resolve(plat, puid),
                        reason=f"same_handle:{plat}:{h}",
                    )
                except Exception as e:
                    logger.debug("merge proposal: %s", e)

        pid = UnifiedIdentityMapper.resolve(plat, puid)
        disp = (display_name or "").strip() or h or pid
        aliases = [x for x in [h] if x]  # nick as alias for mentions; not identity
        self.upsert_person(pid, display_name=disp, aliases=aliases or [pid], meta={})
        self.sqlite.upsert_person_account(
            person_id=pid,
            platform=plat,
            platform_user_id=puid,
            handle=h,
            display_name=display_name,
            avatar_url=avatar_url,
        )
        row = self.sqlite.get_person(pid)
        return self._person_as_legacy_dict(row) if row else {"id": pid}

    def propose_people_merge(
        self, person_a: str, person_b: str, *, reason: str = ""
    ) -> dict[str, Any]:
        a = (person_a or "").strip()
        b = (person_b or "").strip()
        if not a or not b or a == b:
            raise ValueError("two distinct person_ids required")
        if self.sqlite.get_person(a) is None:
            raise KeyError(a)
        if self.sqlite.get_person(b) is None:
            raise KeyError(b)
        pid = self.sqlite.add_merge_proposal(person_a=a, person_b=b, reason=reason or "propose")
        return {"proposal_id": pid, "person_a": a, "person_b": b, "status": "pending"}

    def merge_people(
        self,
        survivor_id: str,
        source_id: str,
        *,
        reason: str = "",
        proposal_id: Optional[int] = None,
    ) -> dict[str, Any]:
        """Atomic merge by exact person_id (admin/API only). Snapshot inside txn."""
        survivor = (survivor_id or "").strip()
        source = (source_id or "").strip()
        if not survivor or not source:
            raise ValueError("survivor_id and source_id required")
        if survivor == source:
            raise ValueError("cannot merge person into itself")
        _log_id, stats = self.sqlite.merge_people_atomic(
            survivor_id=survivor,
            source_id=source,
            reason=reason or "merge",
            proposal_id=proposal_id,
        )
        return stats

    def apply_merge_proposal(self, proposal_id: int) -> dict[str, Any]:
        """Apply pending proposal under one SQLite transaction (race-safe)."""
        _log_id, stats = self.sqlite.merge_people_atomic(
            survivor_id="",  # overridden from proposal inside txn
            source_id="",
            reason=f"proposal:{int(proposal_id)}",
            proposal_id=int(proposal_id),
        )
        return stats

    def undo_merge(self, merge_log_id: int) -> dict[str, Any]:
        return self.sqlite.undo_merge_atomic(int(merge_log_id))

    def wipe(self, scopes: list[str], *, backup_dir: Optional[Path] = None) -> dict[str, Any]:
        """Clear selected memory scopes. Optional backup of SQLite before wipe."""
        allowed = {
            "people",
            "diary",
            "journal",
            "chat_log",
            "working_memory",
            "ltm",
            "merge_log",
        }
        wanted = {str(s).strip().lower() for s in (scopes or []) if str(s).strip()}
        unknown = wanted - allowed - {"stm"}
        if unknown:
            raise ValueError(f"unknown wipe scopes: {sorted(unknown)}")
        if not wanted:
            raise ValueError("scopes required")
        backup_path = None
        chroma_backup = None
        if backup_dir is not None:
            try:
                backup_dir = Path(backup_dir)
                backup_dir.mkdir(parents=True, exist_ok=True)
                ts = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
                dest = backup_dir / f"neyra_memory_pre_wipe_{ts}.db"
                self.sqlite.backup_to(dest)
                backup_path = str(dest)
                if "ltm" in wanted:
                    lm = self._long_memory
                    if lm is not None and hasattr(lm, "backup_to"):
                        cdest = backup_dir / f"neyra_chroma_pre_wipe_{ts}"
                        chroma_backup = lm.backup_to(cdest) or None
                    elif lm is not None:
                        chroma_backup = None
            except RuntimeError:
                raise
            except Exception as e:
                raise RuntimeError(f"wipe backup failed: {e}") from e
        out: dict[str, int] = {}
        if "people" in wanted:
            out["people"] = self.sqlite.clear_table("people")
            try:
                out["merge_log"] = self.sqlite.clear_table("merge_log")
            except Exception:
                out["merge_log"] = 0
            try:
                out["merge_proposals"] = self.sqlite.clear_table("merge_proposals")
            except Exception:
                out["merge_proposals"] = 0
        if "diary" in wanted:
            out["diary"] = self.sqlite.clear_table("diary_notes")
        if "journal" in wanted:
            out["journal"] = self.sqlite.clear_table("journal_entries")
        if "chat_log" in wanted:
            out["chat_log"] = self.sqlite.clear_table("chat_log")
        if "working_memory" in wanted:
            out["working_memory"] = self.sqlite.clear_table("working_memory_snapshots")
        if "ltm" in wanted:
            lm = self._long_memory
            if lm is not None and hasattr(lm, "clear_all"):
                out["ltm"] = int(lm.clear_all() or 0)
            else:
                out["ltm"] = 0
        return {"deleted": out, "backup": backup_path, "chroma_backup": chroma_backup}

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

    def _person_as_legacy_dict(
        self,
        row: dict[str, Any],
        *,
        accounts: Optional[list[dict[str, Any]]] = None,
    ) -> dict[str, Any]:
        """Normalize SQLite people row to API dict (accounts + aliases, no profile)."""
        pid = str(row.get("person_id") or "").strip()
        aliases = self._aliases_list(row.get("aliases"))
        meta = row.get("meta") if isinstance(row.get("meta"), dict) else {}
        if not aliases and isinstance(meta.get("names"), list):
            aliases = [str(x).strip() for x in meta["names"] if str(x).strip()]
        display = str(row.get("display_name") or "").strip()
        names = aliases or ([display] if display else ([pid] if pid else []))
        accs = accounts if accounts is not None else (
            self.sqlite.list_accounts_for_person(pid) if pid else []
        )
        discord_ids = [
            str(a.get("platform_user_id") or "").strip()
            for a in accs
            if str(a.get("platform") or "").lower() == "discord"
            and str(a.get("platform_user_id") or "").strip()
        ]
        if isinstance(meta.get("discord_ids"), list):
            for x in meta["discord_ids"]:
                s = str(x).strip()
                if s and s not in discord_ids:
                    discord_ids.append(s)
        return {
            "id": pid,
            "names": names,
            "aliases": names,
            "accounts": accs,
            "discord_ids": discord_ids,
            "profile": {},
            "static_facts": {},
            "legacy_fact_hints": [],
            "dynamic_facts": list(meta.get("dynamic_facts") or [])
            if isinstance(meta.get("dynamic_facts"), list)
            else [],
            "last_seen": row.get("updated_at") or meta.get("last_seen"),
            "display_name": display or (names[0] if names else pid),
            "meta": meta,
        }

    def list_people(self) -> list[dict[str, Any]]:
        rows = self.sqlite.list_people()
        all_acc = self.sqlite.list_all_accounts()
        by_pid: dict[str, list[dict[str, Any]]] = {}
        for a in all_acc:
            pid = str(a.get("person_id") or "").strip()
            if not pid:
                continue
            by_pid.setdefault(pid, []).append(a)
        return [
            self._person_as_legacy_dict(r, accounts=by_pid.get(str(r.get("person_id") or ""), []))
            for r in rows
        ]

    def find_person(self, identifier: str, discord_id: Optional[str] = None) -> Optional[dict[str, Any]]:
        """Exact identity lookup only (account id / handle / person_id / alias)."""
        discord = (discord_id or "").strip() or None
        if discord:
            acc = self.sqlite.get_account("discord", discord)
            if acc:
                row = self.sqlite.get_person(str(acc.get("person_id") or ""))
                if row:
                    return self._person_as_legacy_dict(row)
            for person in self.list_people():
                if discord in (person.get("discord_ids") or []):
                    return person
        ident = (identifier or "").strip()
        if not ident:
            return None
        ident_lower = ident.casefold()
        row = self.sqlite.get_person(ident)
        if row:
            return self._person_as_legacy_dict(row)
        by_h = self.sqlite.find_person_ids_by_handle_norm(ident)
        if len(by_h) == 1:
            row = self.sqlite.get_person(by_h[0])
            if row:
                return self._person_as_legacy_dict(row)
        for person in self.list_people():
            if str(person.get("id") or "").casefold() == ident_lower:
                return person
            aliases = [str(n).casefold() for n in (person.get("names") or []) if str(n).strip()]
            if ident_lower in aliases:
                return person
        return None

    def get_all_names_map(self) -> dict[str, str]:
        """Map lowercased exact alias/handle → person_id (for mention scan)."""
        result: dict[str, str] = {}
        for person in self.list_people():
            pid = str(person.get("id") or "").strip()
            if not pid:
                continue
            result[pid.casefold()] = pid
            for name in person.get("names") or []:
                key = str(name).strip().casefold()
                if key:
                    result[key] = pid
            for acc in person.get("accounts") or []:
                h = str(acc.get("handle") or "").strip().casefold()
                if h:
                    result[h] = pid
        return result

    def get_person_summary(self, person_id: str) -> str:
        """Prompt dossier: accounts + free-form facts (no анкета)."""
        from core.memory.person_profile import known_name_from_facts, speaker_ref_from_account

        pid = (person_id or "").strip()
        if not pid:
            return ""
        person = self.sqlite.get_person(pid)
        if not person:
            return ""
        accounts = self.sqlite.list_accounts_for_person(pid)
        facts = self.sqlite.list_person_facts(pid, limit=12)
        known = known_name_from_facts(facts)
        handle = ""
        display = str(person.get("display_name") or "").strip()
        for a in accounts:
            if str(a.get("platform") or "").lower() == "discord":
                handle = str(a.get("handle") or "").strip() or handle
                display = str(a.get("display_name") or "").strip() or display
                break
        if not handle:
            aliases = self._aliases_list(person.get("aliases"))
            handle = aliases[0] if aliases else ""
        title = speaker_ref_from_account(
            handle=handle, display_name=display, known_name=known
        )
        lines = [f"Досье на {title}:"]
        for a in accounts:
            plat = str(a.get("platform") or "").strip()
            puid = str(a.get("platform_user_id") or "").strip()
            h = str(a.get("handle") or "").strip()
            if plat == "discord" and puid.isdigit() and 5 <= len(puid) <= 32:
                lines.append(f"  Discord пинг: <@{puid}>" + (f" (@{h})" if h else ""))
            elif plat and puid:
                lines.append(f"  {plat}: {puid}" + (f" (@{h})" if h else ""))
        fact_lines = [
            str(f.get("fact") or "").strip() for f in reversed(facts) if str(f.get("fact") or "").strip()
        ]
        if fact_lines:
            lines.append("  Факты:")
            for fact_line in fact_lines[:12]:
                lines.append(f"    - {fact_line}")
        return "\n".join(lines)

    def delete_diary_note(self, note_id: int) -> bool:
        return self.sqlite.delete_diary_note(note_id)

    def delete_journal_entry(self, entry_id: int) -> bool:
        return self.sqlite.delete_journal_entry(entry_id)

    def diary_recent_text(self, limit: int = 10) -> str:
        """Diary for prompt: Neyra first-person notes only (skip session_archive)."""
        lim = max(1, min(int(limit), 8))
        rows = self.list_diary_notes(limit=max(lim * 3, lim), newest_first=True)
        if not rows:
            return ""
        rows = list(reversed(rows))
        lines: list[str] = []
        for e in rows:
            ts = e.get("ts") or ""
            src = str(e.get("source") or "manual").strip()
            if src == "session_archive":
                continue
            txt = str(e.get("text") or "").strip()
            if not txt:
                continue
            # Cap each note so brain prompt stays clean
            if len(txt) > 280:
                txt = txt[:279] + "…"
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
            "person_accounts": self.sqlite.count_table("person_accounts"),
            "merge_log": self.sqlite.count_table("merge_log"),
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
