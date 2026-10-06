"""Offline Memory v2: mentions, resolve, merge/undo, wipe backup, proposals."""

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


def test_merge_undo_all_facts_and_proposals() -> None:
    from core.memory.hub import MemoryHub
    from core.runtime.identity import UnifiedIdentityMapper

    with tempfile.TemporaryDirectory() as td:
        db = Path(td) / "hub.db"
        hub = MemoryHub({"memory": {"sqlite_path": str(db), "rag_enabled": False}}, long_memory=None)

        a = hub.ensure_person_for_account(
            platform="discord", platform_user_id="111", handle="coolnick", display_name="Cool"
        )
        b = hub.ensure_person_for_account(
            platform="telegram", platform_user_id="222", handle="coolnick", display_name="Cool"
        )
        assert a["id"] != b["id"]
        assert a["id"] == UnifiedIdentityMapper.resolve("discord", "111")

        prop = hub.propose_people_merge(a["id"], b["id"], reason="same_handle")
        prop2 = hub.propose_people_merge(b["id"], a["id"], reason="dup")
        assert prop["proposal_id"] == prop2["proposal_id"]

        # Third person for stale-chain: B↔C pending, then apply A↔B → C proposal rewritten/stale.
        c = hub.ensure_person_for_account(
            platform="discord", platform_user_id="333", handle="other", display_name="Other"
        )
        bc = hub.propose_people_merge(b["id"], c["id"], reason="bc")

        hub.add_person_fact(a["id"], "зовут Иван", source="test")
        hub.add_person_fact(a["id"], "любит кофе", source="test")
        hub.add_person_fact(b["id"], "любит кофе", source="test")
        hub.add_person_fact(b["id"], "играет в доту", source="test")
        # >200 facts on source to verify all ids snapshotted
        for i in range(210):
            hub.add_person_fact(b["id"], f"fact bulk {i}", source="test")

        facts_before_a = sorted(f["fact"] for f in hub.list_person_facts(a["id"], limit=200))
        facts_before_b = {
            str(r["fact"])
            for r in hub.sqlite._conn.execute(
                "SELECT fact FROM person_facts WHERE person_id = ?", (b["id"],)
            ).fetchall()
        }
        assert len(facts_before_b) >= 212

        out = hub.merge_people(
            a["id"], b["id"], reason="proposal_apply", proposal_id=int(prop["proposal_id"])
        )
        assert out["survivor_id"] == a["id"]
        assert hub.sqlite.get_person(b["id"]) is None
        applied = hub.sqlite.get_merge_proposal(int(prop["proposal_id"]))
        assert applied["status"] == "applied"
        assert int(applied["merge_log_id"]) == int(out["merge_log_id"])

        # B↔C rewritten to A↔C (still pending) or stale if collapsed
        bc_row = hub.sqlite.get_merge_proposal(int(bc["proposal_id"]))
        assert bc_row["status"] in ("pending", "stale")
        if bc_row["status"] == "pending":
            assert {bc_row["person_a"], bc_row["person_b"]} == {a["id"], c["id"]}

        n_on_a = hub.sqlite._conn.execute(
            "SELECT COUNT(*) FROM person_facts WHERE person_id = ?", (a["id"],)
        ).fetchone()[0]
        assert int(n_on_a) >= 212

        undo = hub.undo_merge(int(out["merge_log_id"]))
        assert undo["restored_id"] == b["id"]
        facts_a2 = sorted(f["fact"] for f in hub.list_person_facts(a["id"], limit=200))
        facts_b2 = {
            str(r["fact"])
            for r in hub.sqlite._conn.execute(
                "SELECT fact FROM person_facts WHERE person_id = ?", (b["id"],)
            ).fetchall()
        }
        assert facts_a2 == facts_before_a
        assert facts_b2 == facts_before_b

        undone_prop = hub.sqlite.get_merge_proposal(int(prop["proposal_id"]))
        assert undone_prop["status"] == "undone"

        try:
            hub.undo_merge(int(out["merge_log_id"]))
            raise AssertionError("second undo must fail")
        except ValueError as e:
            assert "already_undone" in str(e)

        # Reject path
        rej = hub.propose_people_merge(a["id"], c["id"], reason="rej")
        hub.sqlite.resolve_merge_proposal(int(rej["proposal_id"]), status="rejected")
        assert hub.sqlite.get_merge_proposal(int(rej["proposal_id"]))["status"] == "rejected"

        # Stale apply simulation: propose then delete person
        stale_p = hub.propose_people_merge(a["id"], c["id"], reason="stale")
        hub.delete_person(c["id"])
        # Mimic API: mark stale when person missing
        sp = hub.sqlite.get_merge_proposal(int(stale_p["proposal_id"]))
        assert sp["status"] == "pending"
        if hub.sqlite.get_person(str(sp["person_a"])) is None or hub.sqlite.get_person(
            str(sp["person_b"])
        ) is None:
            hub.sqlite.resolve_merge_proposal(int(stale_p["proposal_id"]), status="stale")
        assert hub.sqlite.get_merge_proposal(int(stale_p["proposal_id"]))["status"] == "stale"

        hub.add_diary_note("feeling ok", source="test")
        out_w = hub.wipe(["people", "diary", "journal"], backup_dir=Path(td) / "backups")
        bak = Path(out_w["backup"])
        assert bak.is_file()
        conn = sqlite3.connect(str(bak))
        try:
            assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] >= 1
        finally:
            conn.close()
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
        assert "Кирилл" in resolve_speaker_label(hub, "pupinos", "555", "Пупинос")
        hub.sqlite.close()


def main() -> int:
    test_detect_mentions_no_false_max()
    test_merge_undo_all_facts_and_proposals()
    test_speaker_label_nick_not_invented_name()
    print("OK test_memory_v2_people_offline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
