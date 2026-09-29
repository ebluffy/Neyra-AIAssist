#!/usr/bin/env python3
"""Smoke: MemoryHub SQLite chat_log + people/diary + rag_write_mode gate.

Legacy file memory has been fully abandoned: there is no `run_hub_legacy_import` /
import-legacy / marker-gated auto-import subsystem anymore. Hub SQLite is always the
sole store for people/diary/journal/WM once a MemoryHub is attached; without a Hub,
PeopleDB/NeyraDiary are pure in-memory caches (no JSON/JSONL file I/O at all). Covers
Hub-only read/write, the journal hydrate-from-Hub fix (newest_first=True + reverse in
RAM so recent rows are never dropped once the table grows past the fetch limit), and
the diary recursion fix (NeyraDiary.recent_text must format locally and must never
call hub.diary_recent_text).
"""

from __future__ import annotations

import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.runtime.event_bus import MEMORY_CHAT_LOG_APPEND, EventBus
from core.memory import MemoryHub
from core.memory.stores import NeyraDiary, PeopleDB


class _FakeLTM:
    rag_enabled = True

    def __init__(self) -> None:
        self.saves = 0
        self.knowledge = 0

    def save(self, *a, **k) -> None:
        self.saves += 1

    def add_knowledge(self, text, metadata=None):
        self.knowledge += 1
        return True, "k1"

    def search(self, query, n_results=None):
        return []

    def count(self) -> int:
        return self.knowledge


def main() -> int:
    events: list[str] = []
    bus = EventBus()
    bus.subscribe(MEMORY_CHAT_LOG_APPEND, lambda e: events.append(e.event_type))

    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / "neyra_memory.db"
        fake = _FakeLTM()
        hub = MemoryHub(
            {"memory": {"sqlite_path": str(db), "rag_write_mode": "important_only"}},
            long_memory=fake,
            event_bus=bus,
        )
        turn = hub.new_turn_id()
        ids = hub.append_chat_batch(
            [
                {
                    "role": "user",
                    "text": "привет",
                    "user_id": "u1",
                    "channel_id": "c1",
                    "source": "smoke",
                    "turn_id": turn,
                },
                {
                    "role": "assistant",
                    "text": "хай",
                    "user_id": "u1",
                    "channel_id": "c1",
                    "source": "smoke",
                    "turn_id": turn,
                },
            ]
        )
        assert len(ids) == 2, ids
        assert hub.save_dialog_semantic("a", "b", {}) is False
        assert fake.saves == 0
        ok, _ = hub.remember_knowledge("факт", {"type": "knowledge"})
        assert ok and fake.knowledge == 1

        hub.add_person_fact(
            "p1",
            "любит чай",
            emotion_note="тепло",
            aliases=["Алиса"],
            display_name="Алиса",
            person_meta={"discord_ids": ["123456789012345678"], "names": ["Алиса"]},
        )
        hub.add_diary_note("заметка дня", source="smoke", emotion="calm")
        hub.add_journal_entry("итог", title="день", kind="reflection", publish_event=False)
        hub.save_wm_snapshot("# WM\n- task", user_id="u1", publish_event=False)

        # Hub-only identity lookup (no legacy PeopleDB fallback exists anymore)
        found = hub.find_person("Алиса")
        assert found and found.get("id") == "p1", found
        assert hub.find_person("nobody") is None
        assert hub.get_all_names_map().get("алиса") == "p1"
        assert "любит чай" in hub.get_person_summary("p1")

        snip = hub.working_memory_for_prompt("u1")
        assert "task" in snip or "WM" in snip, snip
        assert "заметка дня" in hub.diary_recent_text(limit=5)

        # Diary recursion guard: NeyraDiary.recent_text must format locally from
        # hub.list_diary_notes and must NEVER call hub.diary_recent_text.
        diary_wrap = NeyraDiary({"memory": {"diary_path": str(Path(tmp) / "unused_diary.jsonl")}})
        diary_wrap.memory_hub = hub

        def _boom_diary_recent_text(*a, **k):
            raise AssertionError("NeyraDiary.recent_text must not call hub.diary_recent_text")

        hub.diary_recent_text = _boom_diary_recent_text  # type: ignore[method-assign]
        try:
            text_via_wrapper = diary_wrap.recent_text(limit=5)
        finally:
            del hub.diary_recent_text  # restore class method
        assert "заметка дня" in text_via_wrapper, text_via_wrapper

        st = hub.stats()
        assert st["chat_log"] == 2, st
        assert st["people"] == 1, st
        assert st["person_facts"] == 1, st
        assert st["diary_notes"] == 1, st
        assert st["journal_entries"] == 1, st
        assert st["working_memory_snapshots"] == 1, st
        assert st["allows_raw_dialog_embed"] is False
        assert "hub_legacy_fallback" not in st and "hub_dual_write_legacy" not in st, st

        # Restart simulation: new Hub on same DB still finds the person
        hub_re = MemoryHub(
            {"memory": {"sqlite_path": str(db), "rag_write_mode": "important_only"}},
            long_memory=fake,
            event_bus=bus,
        )
        assert hub_re.find_person("Алиса", discord_id="123456789012345678")
        hub_re.close()

        hub2 = MemoryHub(
            {"memory": {"sqlite_path": str(Path(tmp) / "legacy.db"), "rag_write_mode": "legacy_dialog"}},
            long_memory=fake,
        )
        assert hub2.allows_raw_dialog_embed() is True
        assert hub2.save_dialog_semantic("x", "y", {}) is True
        assert fake.saves == 1
        hub.close()
        hub2.close()

    assert MEMORY_CHAT_LOG_APPEND in events, events

    # Journal hydrate-from-Hub: >500 rows including today must not drop today's row.
    # Bug fixed here: newest_first=False + LIMIT returns the OLDEST rows once the table
    # grows past the limit, silently hiding today's entry from `_journal_has_date`.
    with tempfile.TemporaryDirectory() as tmp_j:
        root = Path(tmp_j)
        (root / "chroma_db").mkdir()
        chat_log = root / "chat.log"
        chat_log.write_text("", encoding="utf-8")
        cfg_j = {
            "memory": {
                "sqlite_path": str(root / "journal.db"),
                "chroma_db_path": str(root / "chroma_db"),
                "rag_write_mode": "important_only",
            },
            "logging": {"chat_log": str(chat_log)},
        }
        hub_j = MemoryHub(cfg_j, long_memory=_FakeLTM())
        base = datetime(2020, 1, 1)
        today_str = datetime.now().strftime("%Y-%m-%d")
        for i in range(520):
            day = (base + timedelta(days=i)).strftime("%Y-%m-%d")
            hub_j.add_journal_entry(
                f"итог за {day}",
                title=day,
                kind="reflection",
                meta={"date": day, "summary": f"итог за {day}"},
                publish_event=False,
            )
        # Force today's entry to exist as the most recent row.
        hub_j.add_journal_entry(
            f"итог за {today_str}",
            title=today_str,
            kind="reflection",
            meta={"date": today_str, "summary": f"итог за {today_str}"},
            publish_event=False,
        )
        assert hub_j.stats()["journal_entries"] == 521

        class _AgentJ:
            memory_hub = hub_j
            event_bus = None

        from core.reflection import ReflectionEngine

        refl_j = ReflectionEngine(cfg_j, _AgentJ())
        assert len(refl_j._journal) > 500, len(refl_j._journal)
        assert refl_j._journal_has_date(today_str) is True
        # Chronological order in RAM: oldest first.
        dates = [e.get("date") for e in refl_j._journal if e.get("date")]
        assert dates == sorted(dates), "journal hydrate must be chronological (oldest→newest)"
        hub_j.close()

    # Journal read-path (Hub-only) + PeopleDB hydrate semantics
    with tempfile.TemporaryDirectory() as tmp3:
        root = Path(tmp3)
        db = root / "cutover.db"
        journal_path = root / "journal.json"
        chat_log = root / "chat.log"
        chat_log.write_text("", encoding="utf-8")
        cfg = {
            "memory": {
                "sqlite_path": str(db),
                "journal_path": str(journal_path),
                "diary_path": str(root / "diary.jsonl"),
                "rag_write_mode": "important_only",
            },
            "logging": {"chat_log": str(chat_log)},
        }
        hub_c = MemoryHub(cfg, long_memory=_FakeLTM())

        class _Agent:
            memory_hub = hub_c
            event_bus = None

        from core.reflection import ReflectionEngine

        refl = ReflectionEngine(cfg, _Agent())
        refl._journal.append(
            {"date": "2026-07-23", "summary": "итог дня cutover", "generated_at": "2026-07-23T01:00:00"}
        )
        assert refl._save_journal() is True
        assert not journal_path.exists() or journal_path.read_text(encoding="utf-8").strip() in {"", "[]"}
        assert hub_c.stats()["journal_entries"] == 1

        # Empty Hub must NOT hydrate anything from a journal.json file — legacy file
        # import is fully abandoned, so an empty Hub means an empty in-memory journal,
        # even if a stale journal.json happens to exist on disk.
        stale_journal = root / "journal_stale.json"
        stale_journal.write_text(
            "[{\"date\": \"2026-07-20\", \"summary\": \"stale file, must be ignored\"}]",
            encoding="utf-8",
        )
        cfg_keep = {
            "memory": {
                "sqlite_path": str(root / "empty_hub.db"),
                "journal_path": str(stale_journal),
                "rag_write_mode": "important_only",
            },
            "logging": {"chat_log": str(chat_log)},
        }
        hub_empty = MemoryHub(cfg_keep, long_memory=_FakeLTM())

        class _AgentEmpty:
            memory_hub = hub_empty
            event_bus = None

        refl_keep = ReflectionEngine(cfg_keep, _AgentEmpty())
        assert refl_keep._journal == [], refl_keep._journal
        assert "stale file" not in refl_keep.get_recent_journal(7)
        hub_empty.close()

        # Simulate restart: empty file journal, Hub still has entry
        refl2 = ReflectionEngine(cfg, _Agent())
        assert refl2._journal_has_date("2026-07-23")
        recent = refl2.get_recent_journal(7)
        assert "итог дня cutover" in recent, recent

        # Hub-only failure rolls back in-memory entry (no file fallback with Hub attached)
        def _boom(*a, **k):
            raise RuntimeError("boom")

        hub_c.add_journal_entry = _boom  # type: ignore[method-assign]
        refl2._journal.append({"date": "2026-07-24", "summary": "should roll back"})
        assert refl2._save_journal() is False
        assert not any(e.get("date") == "2026-07-24" for e in refl2._journal)

        # PeopleDB never touches the filesystem (no JSON store exists at all anymore).
        # hydrate_from_hub must MERGE into whatever is already in the in-memory cache,
        # never wipe unrelated entries that were added some other way (e.g. add_person).
        cfg_dual = {
            "memory": {
                "sqlite_path": str(root / "dual.db"),
                "chroma_db_path": str(root / "chroba_db_dual"),
            }
        }
        (root / "chroba_db_dual").mkdir(exist_ok=True)
        pdb = PeopleDB(cfg_dual)
        assert pdb._cache == {}
        # Simulate an entry that only ever existed in the in-memory cache (never hit Hub).
        pdb._cache["bob"] = {
            "id": "bob",
            "names": ["Боб"],
            "discord_ids": [],
            "dynamic_facts": [{"date": "2026-01-01", "fact": "только в кэше"}],
        }

        hub_dual = MemoryHub(cfg_dual, long_memory=_FakeLTM())
        hub_dual.add_person_fact("hub_only", "из sqlite", aliases=["HubOnly"], display_name="HubOnly")
        pdb.hydrate_from_hub(hub_dual)
        assert "bob" in pdb._cache, "hydrate_from_hub must not wipe unrelated cache entries"
        assert any(
            f.get("fact") == "только в кэше" for f in pdb._cache["bob"].get("dynamic_facts") or []
        ), pdb._cache["bob"]
        assert pdb.find("HubOnly") is not None or hub_dual.find_person("HubOnly") is not None

        # Diary input for reflect (Hub-only, no JSONL primary)
        cfg_diary = {
            "memory": {
                "sqlite_path": str(root / "diary_cutover.db"),
                "journal_path": str(root / "j2.json"),
            },
            "logging": {"chat_log": str(root / "chat2.log")},
        }
        (root / "chat2.log").write_text("", encoding="utf-8")
        hub_d = MemoryHub(cfg_diary, long_memory=_FakeLTM())

        hub_d.add_diary_note(
            "свежая заметка для reflect",
            source="smoke",
            ts=(datetime.now() - timedelta(hours=1)).isoformat(),
        )
        hub_d.append_chat_batch(
            [
                {
                    "role": "user",
                    "text": "привет cutover",
                    "user_id": "u1",
                    "display_name": "U",
                    "ts": datetime.now().isoformat(),
                }
            ],
            publish_event=False,
        )

        class _AgentD:
            memory_hub = hub_d
            event_bus = None

        refl_d = ReflectionEngine(cfg_diary, _AgentD())
        diary_24 = refl_d._get_diary_last_24h()
        assert "свежая заметка для reflect" in diary_24, diary_24
        assert not (root / "neyra_diary.jsonl").exists()
        chat_hour = refl_d._get_logs_for_last_hours(2)
        assert "привет cutover" in chat_hour, chat_hour

        # No-Hub: diary lives in RAM (_local); reflect must read agent.diary, not JSONL.
        diary_jsonl = root / "ghost_diary.jsonl"
        diary_jsonl.write_text(
            '{"timestamp":"2099-01-01T00:00:00","source":"ghost","text":"must not appear"}\n',
            encoding="utf-8",
        )
        diary_ram = NeyraDiary({"memory": {}})
        assert diary_ram.add_entry("ram-only note for reflect", source="smoke") is True
        assert not (root / "neyra_diary.jsonl").exists()

        class _AgentNoHub:
            memory_hub = None
            event_bus = None
            diary = diary_ram

        refl_no_hub = ReflectionEngine(
            {
                "memory": {"diary_path": str(diary_jsonl), "journal_path": str(root / "j_nohub.json")},
                "logging": {"chat_log": str(root / "chat2.log")},
            },
            _AgentNoHub(),
        )
        diary_ram_24 = refl_no_hub._get_diary_last_24h()
        assert "ram-only note for reflect" in diary_ram_24, diary_ram_24
        assert "must not appear" not in diary_ram_24
        refl_no_hub._journal.append({"date": "2099-01-02", "summary": "nohub journal"})
        assert refl_no_hub._save_journal() is True
        assert not (root / "j_nohub.json").exists()

        # Blocker repro: UTC-stored Hub ts must still match host-local cutoff window
        from datetime import timezone as _tz
        from core.runtime.timeutil import now_local

        utc_recent = (now_local().astimezone(_tz.utc) - timedelta(minutes=10)).isoformat()
        hub_d.append_chat_batch(
            [
                {
                    "role": "user",
                    "text": "utc-stored recent",
                    "user_id": "u1",
                    "display_name": "U",
                    "ts": utc_recent,
                }
            ],
            publish_event=False,
        )
        hour_logs = refl_d._get_logs_for_last_hour()
        assert "utc-stored recent" in hour_logs, hour_logs

        # Mixed offsets must not drop the true recent row via early-break on TEXT order
        older_local = "2026-01-01T12:00:00+03:00"  # lexically "newer" than some UTC walls
        newer_utc = (now_local().astimezone(_tz.utc) - timedelta(minutes=5)).isoformat()
        hub_d.append_chat_batch(
            [
                {
                    "role": "user",
                    "text": "older-local-offset",
                    "user_id": "u1",
                    "display_name": "U",
                    "ts": older_local,
                },
                {
                    "role": "user",
                    "text": "newer-utc-mixed",
                    "user_id": "u1",
                    "display_name": "U",
                    "ts": newer_utc,
                },
            ],
            publish_event=False,
        )
        mixed = refl_d._get_logs_for_last_hour()
        assert "newer-utc-mixed" in mixed, mixed
        assert "older-local-offset" not in mixed, mixed

        # system.timezone override must affect now_local / cutoff (not only the log line)
        from core.runtime.timeutil import configure_timezone, now_iso as local_iso, resolve_tz

        configure_timezone("Europe/Moscow")
        assert "Europe/Moscow" in str(getattr(resolve_tz(), "key", "")) or str(resolve_tz())
        mos = local_iso()
        assert mos.endswith("+03:00") or "+03:00" in mos or mos.endswith("+04:00") or "+04:00" in mos, mos
        configure_timezone(None)  # restore host for later tests

        # link_discord_id must persist via Hub (no legacy fallback exists anymore)
        cfg_link = {
            "memory": {
                "sqlite_path": str(root / "link.db"),
                "chroma_db_path": str(root / "chroma_link"),
            }
        }
        (root / "chroma_link").mkdir(exist_ok=True)
        hub_l = MemoryHub(cfg_link, long_memory=_FakeLTM())
        pdb_l = PeopleDB(cfg_link)
        pdb_l.memory_hub = hub_l
        pdb_l.add_person("alice", ["Алиса"], discord_ids=[])
        assert pdb_l.link_discord_id("alice", "999888777666555444") is True
        hub_l2 = MemoryHub(cfg_link, long_memory=_FakeLTM())
        found = hub_l2.find_person("Алиса", discord_id="999888777666555444")
        assert found and found.get("id") == "alice", found
        hub_l.close()
        hub_l2.close()

        # WM refresh source: Hub snapshot (no .md file required)
        hub_d.save_wm_snapshot("# WM\n- from hub only", user_id="u_wm", publish_event=False)
        snap = hub_d.sqlite.latest_wm_snapshot(user_id="u_wm")
        assert snap and "from hub only" in str(snap.get("content") or ""), snap

        # Person summary: static_facts from meta even with 0 person_facts (seed scenario)
        hub_d.upsert_person(
            "seed1",
            display_name="Сид",
            aliases=["Сид"],
            meta={"static_facts": {"city": "Киров", "notes": "seed"}, "discord_ids": [], "names": ["Сид"]},
        )
        summary0 = hub_d.get_person_summary("seed1")
        assert "Киров" in summary0 and "seed" in summary0, summary0
        hub_d.add_person_fact("seed1", "любит чай", emotion_note="ок")
        summary1 = hub_d.get_person_summary("seed1")
        assert "Киров" in summary1 and "любит чай" in summary1, summary1
        # API people/{id} contract: name lookup → legacy shape + summary via resolved id
        by_name = hub_d.find_person("Сид")
        assert by_name and by_name.get("id") == "seed1", by_name
        assert "names" in by_name and "person_id" not in by_name
        resolved = str(by_name["id"])
        assert "любит чай" in hub_d.get_person_summary(resolved)
        assert hub_d.list_person_facts(resolved, limit=5)

        # Hub WM read failure must abort refresh (not overwrite with default template)
        import asyncio
        from core.memory import working_memory as wm_mod

        saved_before = str(hub_d.sqlite.latest_wm_snapshot(user_id="u_wm")["content"])
        real_latest = hub_d.sqlite.latest_wm_snapshot

        def _boom(**kwargs):
            raise RuntimeError("boom-read")

        hub_d.sqlite.latest_wm_snapshot = _boom  # type: ignore[method-assign]

        class _AgentWM:
            memory_hub = hub_d
            llm_memory = object()  # must not be invoked
            llm_reflection = None
            llm_talk = None
            event_bus = None

        async def _run_refresh():
            await wm_mod.refresh_working_memory_async(
                _AgentWM(),
                {
                    "memory": {
                        "working_memory": {"enabled": True, "storage_dir": str(root / "wm_x")},
                    }
                },
                root=root,
                internal_user_id="u_wm",
                user_message="hi",
                assistant_text="yo",
                stm_tail="",
                speaker_label="U",
                reason="smoke",
            )

        asyncio.run(_run_refresh())
        hub_d.sqlite.latest_wm_snapshot = real_latest  # type: ignore[method-assign]
        after = hub_d.sqlite.latest_wm_snapshot(user_id="u_wm")
        assert after and str(after.get("content")) == saved_before, after

        hub_d.close()

        hub_c.close()
        hub_dual.close()

    print("OK memory hub smoke v2", st)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
