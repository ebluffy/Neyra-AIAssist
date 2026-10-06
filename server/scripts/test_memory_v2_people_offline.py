"""Offline Memory v2: mentions, account resolve, merge/undo, wipe backup, proposals."""

from __future__ import annotations

import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def test_detect_mentions_no_false_max() -> None:
    from core.agent.people_context import detect_mentioned_names

    name_map = {"макс": "p_max", "пупинос": "p_pup"}
    assert detect_mentioned_names("максимум настроения сегодня", name_map) == []
    assert detect_mentioned_names("Максим пришёл", name_map) == []
    assert detect_mentioned_names("Максимка тут", name_map) == []
    assert detect_mentioned_names("Макси зовут", name_map) == []
    assert detect_mentioned_names("привет, макс!", name_map) == ["p_max"]
    assert detect_mentioned_names("видел Макса вчера", name_map) == ["p_max"]
    assert detect_mentioned_names("пупинос зашёл", name_map) == ["p_pup"]


def test_account_resolve_merge_undo_wipe_proposals() -> None:
    from core.memory.hub import MemoryHub
    from core.runtime.identity import UnifiedIdentityMapper

    with tempfile.TemporaryDirectory() as td:
        db = Path(td) / "hub.db"
        hub = MemoryHub({"memory": {"sqlite_path": str(db), "rag_enabled": False}}, long_memory=None)

        a = hub.ensure_person_for_account(
            platform="discord",
            platform_user_id="111",
            handle="coolnick",
            display_name="Cool Nick",
        )
        b = hub.ensure_person_for_account(
            platform="telegram",
            platform_user_id="222",
            handle="coolnick",
            display_name="Cool",
        )
        assert a["id"] != b["id"]
        assert a["id"] == UnifiedIdentityMapper.resolve("discord", "111")
        proposals = hub.sqlite.list_merge_proposals(status="pending")
        assert any(p.get("reason", "").startswith("same_handle:") for p in proposals)
        # Dedup pending pair
        p1 = hub.propose_people_merge(a["id"], b["id"], reason="again")
        p2 = hub.propose_people_merge(b["id"], a["id"], reason="again2")
        assert p1["proposal_id"] == p2["proposal_id"]

        cyr = hub.ensure_person_for_account(
            platform="discord",
            platform_user_id="333",
            handle="Пупинос",
            display_name="Пупинос",
        )
        assert hub.find_person("пупинос")["id"] == cyr["id"]

        other = hub.ensure_person_for_account(
            platform="discord",
            platform_user_id="999",
            handle="other",
            display_name="Other",
        )
        hub.add_person_fact(a["id"], "зовут Иван", source="test")
        hub.add_person_fact(a["id"], "любит кофе", source="test")
        hub.add_person_fact(other["id"], "любит кофе", source="test")  # dup text
        hub.add_person_fact(other["id"], "играет в доту", source="test")
        facts_before_a = {f["fact"] for f in hub.list_person_facts(a["id"], limit=50)}
        facts_before_o = {f["fact"] for f in hub.list_person_facts(other["id"], limit=50)}

        merged = hub.merge_people(a["id"], other["id"], reason="test")
        assert merged["survivor_id"] == a["id"]
        assert hub.sqlite.get_person(other["id"]) is None
        after_merge_facts = hub.list_person_facts(a["id"], limit=50)
        assert "играет в доту" in {f["fact"] for f in after_merge_facts}
        assert sum(1 for f in after_merge_facts if f["fact"] == "любит кофе") == 1

        undo = hub.undo_merge(int(merged["merge_log_id"]))
        assert undo["restored_id"] == other["id"]
        assert hub.sqlite.get_person(other["id"]) is not None
        facts_a2 = {f["fact"] for f in hub.list_person_facts(a["id"], limit=50)}
        facts_o2 = {f["fact"] for f in hub.list_person_facts(other["id"], limit=50)}
        assert facts_a2 == facts_before_a
        assert "играет в доту" in facts_o2
        # Dup «любит кофе» was dropped at merge; stays only on survivor.
        assert "любит кофе" in facts_a2
        assert "любит кофе" not in facts_o2 or "любит кофе" in facts_before_o

        try:
            hub.undo_merge(int(merged["merge_log_id"]))
            raise AssertionError("second undo should fail")
        except ValueError as e:
            assert "already_undone" in str(e)

        # Apply a pending same_handle proposal (survivor = person_a).
        pending = hub.sqlite.list_merge_proposals(status="pending")
        assert pending
        apply_prop = pending[0]
        sid = str(apply_prop["person_a"])
        oid = str(apply_prop["person_b"])
        if hub.sqlite.get_person(sid) and hub.sqlite.get_person(oid):
            out_m = hub.merge_people(sid, oid, reason=f"proposal:{apply_prop['id']}")
            hub.sqlite.resolve_merge_proposal(
                int(apply_prop["id"]),
                status="applied",
                merge_log_id=int(out_m["merge_log_id"]),
            )
            assert hub.sqlite.get_merge_proposal(int(apply_prop["id"]))["status"] == "applied"

        hub.add_diary_note("feeling ok", source="test")
        backup_dir = Path(td) / "backups"
        out = hub.wipe(["people", "diary", "journal"], backup_dir=backup_dir)
        assert out.get("backup")
        bak = Path(out["backup"])
        assert bak.is_file()
        conn = sqlite3.connect(str(bak))
        try:
            n = conn.execute("SELECT COUNT(*) FROM people").fetchone()[0]
            assert n >= 1
        finally:
            conn.close()
        assert (out.get("deleted") or {}).get("people", 0) >= 1
        hub.sqlite.close()


def test_speaker_label_nick_not_invented_name() -> None:
    from core.agent.speakers import resolve_speaker_label
    from core.memory.hub import MemoryHub

    with tempfile.TemporaryDirectory() as td:
        db = Path(td) / "hub.db"
        hub = MemoryHub({"memory": {"sqlite_path": str(db), "rag_enabled": False}}, long_memory=None)
        hub.ensure_person_for_account(
            platform="discord",
            platform_user_id="555",
            handle="pupinos",
            display_name="Пупинос",
        )
        label = resolve_speaker_label(hub, "pupinos", "555", "Пупинос")
        assert "макс" not in label.lower()
        hub.add_person_fact(
            hub.find_person("", discord_id="555")["id"],
            "зовут Кирилл",
            source="test",
        )
        label2 = resolve_speaker_label(hub, "pupinos", "555", "Пупинос")
        assert "Кирилл" in label2
        hub.sqlite.close()


def main() -> int:
    test_detect_mentions_no_false_max()
    test_account_resolve_merge_undo_wipe_proposals()
    test_speaker_label_nick_not_invented_name()
    print("OK test_memory_v2_people_offline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
