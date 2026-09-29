#!/usr/bin/env python3
"""Offline acceptance for Memory Hub Phase 1A (no live Discord/API server), legacy import abandoned.

No `hub_legacy_import` / `hub_legacy_fallback` / `hub_dual_write_legacy` flags, and no
`run_hub_legacy_import` / import-legacy / marker-gated auto-import subsystem, exist anymore.
Whenever a MemoryHub is attached, people/diary/journal/WM are SQLite-only: `PeopleDB` and
`NeyraDiary` never touch the filesystem at all (no JSON/JSONL read or write, no `db_dir`).
This script simulates two agent starts against the same SQLite DB (fresh write, then
"restart" with a brand-new PeopleDB/NeyraDiary/ReflectionEngine wired to the same Hub) and
asserts every read path still works without any legacy files on disk.
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.memory import MemoryHub
from core.memory.stores import NeyraDiary, PeopleDB
from core.reflection import ReflectionEngine
from core.runtime.timeutil import now_local


class _FakeLTM:
    rag_enabled = True

    def save(self, *a, **k) -> None:
        return None

    def add_knowledge(self, text, metadata=None):
        return True, "k1"

    def search(self, query, n_results=None):
        return []

    def count(self) -> int:
        return 0


def _cfg(root: Path) -> dict:
    return {
        "memory": {
            "sqlite_path": str(root / "neyra_memory.db"),
            "chroma_db_path": str(root / "chroma_db"),
            "diary_path": str(root / "neyra_diary.jsonl"),
            "journal_path": str(root / "journal.json"),
            "rag_write_mode": "important_only",
            "working_memory": {
                "enabled": True,
                "storage_dir": str(root / "working_memory"),
            },
        },
        "logging": {"chat_log": str(root / "chat.log")},
        "system": {"timezone": None},
    }


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        (root / "chroma_db").mkdir()
        (root / "chat.log").write_text("", encoding="utf-8")

        # --- "Session A": first agent start writes via the thin wrappers ---
        cfg_a = _cfg(root)
        hub_a = MemoryHub(cfg_a, long_memory=_FakeLTM())
        people = PeopleDB(cfg_a)
        assert people._cache == {}  # no filesystem at all — starts as an empty in-memory cache
        people.memory_hub = hub_a
        people.hydrate_from_hub(hub_a)  # nothing to hydrate on a fresh Hub
        diary = NeyraDiary(cfg_a)
        diary.memory_hub = hub_a

        created = people.add_person(
            "cutover_user",
            ["Катя", "Kate"],
            discord_ids=["123456789012345678"],
        )
        assert created.get("id") == "cutover_user"
        assert people.update_fact("cutover_user", "любит чай", emotion="тепло") is True
        assert people.link_discord_id("cutover_user", "123456789012345678") is False  # already linked
        assert diary.add_entry("заметка dual", source="cutover") is True
        hub_a.add_journal_entry(
            "рефлексия dual",
            title="2026-07-23",
            kind="reflection",
            meta={"date": "2026-07-23", "summary": "рефлексия dual"},
            publish_event=False,
        )
        hub_a.save_wm_snapshot("# WM\n- task dual", user_id="u_cut", publish_event=False)
        hub_a.append_chat_batch(
            [
                {
                    "role": "user",
                    "text": "привет cutover",
                    "user_id": "u_cut",
                    "display_name": "Катя",
                    "channel_id": "c1",
                    "ts": now_local().isoformat(),
                },
                {
                    "role": "assistant",
                    "text": "хай",
                    "user_id": "u_cut",
                    "display_name": "Нейра",
                    "channel_id": "c1",
                    "ts": now_local().isoformat(),
                },
            ],
            publish_event=False,
        )
        st_a = hub_a.stats()
        assert st_a["people"] >= 1 and st_a["person_facts"] >= 1
        assert st_a["diary_notes"] >= 1 and st_a["journal_entries"] >= 1
        assert st_a["working_memory_snapshots"] >= 1 and st_a["chat_log"] >= 2
        assert "hub_legacy_fallback" not in st_a and "hub_dual_write_legacy" not in st_a, st_a

        # Hub-only invariant: PeopleDB/NeyraDiary never touch the filesystem, Hub or not.
        assert not (root / "people_db").exists()
        assert not (root / "neyra_diary.jsonl").exists()
        hub_a.close()

        # --- "Session B": fresh wrappers against the same Hub SQLite DB ("restart") ---
        cfg_b = _cfg(root)
        hub_b = MemoryHub(cfg_b, long_memory=_FakeLTM())
        people_b = PeopleDB(cfg_b)
        assert people_b._cache == {}  # __init__ never auto-loads JSON
        people_b.memory_hub = hub_b
        people_b.hydrate_from_hub(hub_b)
        diary_b = NeyraDiary(cfg_b)
        diary_b.memory_hub = hub_b

        class _Agent:
            memory_hub = hub_b
            event_bus = None
            people_db = people_b
            diary = diary_b

        refl = ReflectionEngine(cfg_b, _Agent())

        # Identity + summary survive without any JSON/JSONL on disk
        found = hub_b.find_person("Катя", discord_id="123456789012345678")
        assert found and found.get("id") == "cutover_user", found
        assert "names" in found and "person_id" not in found
        # Mirror GET /v1/memory/people/{person_id}: resolve name → dossier fields
        resolved = str(found.get("id") or "")
        summary = hub_b.get_person_summary(resolved)
        assert "любит чай" in summary, summary
        assert hub_b.list_person_facts(resolved, limit=5)
        assert hub_b.get_all_names_map().get("катя") == "cutover_user"
        # PeopleDB thin wrapper reflects the same hydrated data
        assert people_b.find("Катя") is not None
        assert "любит чай" in people_b.get_summary("cutover_user")

        # Diary / journal / chat / WM reads (Hub only, no recursion between
        # NeyraDiary.recent_text and MemoryHub.diary_recent_text)
        assert "заметка dual" in hub_b.diary_recent_text(10)
        assert "заметка dual" in diary_b.recent_text(10)
        assert "заметка dual" in refl._get_diary_last_24h()
        assert hub_b.list_journal_entries(limit=5)
        assert "привет cutover" in refl._get_logs_for_last_hours(24)
        assert "task dual" in hub_b.working_memory_for_prompt("u_cut")

        # Diary recursion guard: hub.diary_recent_text must not depend on diary_b.recent_text
        def _boom(*a, **k):
            raise AssertionError("MemoryHub.diary_recent_text must not call NeyraDiary.recent_text")

        diary_b.recent_text = _boom  # type: ignore[method-assign]
        try:
            assert "заметка dual" in hub_b.diary_recent_text(10)
        finally:
            del diary_b.recent_text

        # Hub-only writes still work
        assert diary_b.add_entry("после cutover", source="cutover") is True
        assert not (root / "neyra_diary.jsonl").exists()
        assert people_b.update_fact("cutover_user", "факт после cutover") is True
        assert "факт после cutover" in hub_b.get_person_summary("cutover_user")

        # Hub people survive restart without any JSON seed re-creation
        if int(hub_b.stats().get("people") or 0) > 0 or people_b._cache:
            pass  # invariant holds
        else:
            raise AssertionError("Hub people missing after restart")

        hub_b.close()

    print("OK memory cutover offline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
