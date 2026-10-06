"""Offline Memory v2: mentions, resolve, merge/undo, wipe, proposals lifecycle."""

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


def test_speaker_label_nick_not_invented_name() -> None:
    from core.agent.speakers import resolve_speaker_label
    from core.memory.hub import MemoryHub

    td_obj = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    hub = None
    try:
        hub = MemoryHub(
            {"memory": {"sqlite_path": str(Path(td_obj.name) / "hub.db"), "rag_enabled": False}},
            long_memory=None,
        )
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
    finally:
        if hub is not None:
            hub.sqlite.close()
        td_obj.cleanup()


def test_merge_undo_proposals_lifecycle() -> None:
    from core.memory.hub import MemoryHub
    from core.memory.stores import LongTermMemory
    from core.runtime.identity import UnifiedIdentityMapper

    td_obj = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    td = td_obj.name
    hub = None
    hub2 = None
    try:
        hub = MemoryHub(
            {"memory": {"sqlite_path": str(Path(td) / "hub.db"), "rag_enabled": False}},
            long_memory=None,
        )

        a = hub.ensure_person_for_account(
            platform="discord", platform_user_id="111", handle="coolnick", display_name="A"
        )
        b = hub.ensure_person_for_account(
            platform="telegram", platform_user_id="222", handle="coolnick", display_name="B"
        )
        assert a["id"] == UnifiedIdentityMapper.resolve("discord", "111")
        c = hub.ensure_person_for_account(
            platform="discord", platform_user_id="333", handle="other", display_name="C"
        )
        created_b = hub.sqlite.get_person(b["id"])["created_at"]

        ab = hub.propose_people_merge(a["id"], b["id"], reason="ab")
        ab2 = hub.propose_people_merge(b["id"], a["id"], reason="ab_sym")
        assert ab["proposal_id"] == ab2["proposal_id"]
        bc = hub.propose_people_merge(b["id"], c["id"], reason="bc")
        ac = hub.propose_people_merge(a["id"], c["id"], reason="ac")

        hub.add_person_fact(a["id"], "зовут Иван", source="t")
        hub.add_person_fact(a["id"], "любит кофе", source="t")
        hub.add_person_fact(b["id"], "любит кофе", source="t")
        hub.add_person_fact(b["id"], "играет в доту", source="t")
        for i in range(210):
            hub.add_person_fact(b["id"], f"fact bulk {i}", source="t")

        facts_before_a = {
            str(r["fact"])
            for r in hub.sqlite._conn.execute(
                "SELECT fact FROM person_facts WHERE person_id = ?", (a["id"],)
            )
        }
        facts_before_b = {
            str(r["fact"])
            for r in hub.sqlite._conn.execute(
                "SELECT fact FROM person_facts WHERE person_id = ?", (b["id"],)
            )
        }

        out = hub.apply_merge_proposal(int(ab["proposal_id"]))
        assert out["survivor_id"] == a["id"]
        assert hub.sqlite.get_merge_proposal(int(ab["proposal_id"]))["status"] == "applied"

        bc_row = hub.sqlite.get_merge_proposal(int(bc["proposal_id"]))
        ac_row = hub.sqlite.get_merge_proposal(int(ac["proposal_id"]))
        assert bc_row["status"] == "pending"
        assert {bc_row["person_a"], bc_row["person_b"]} == {a["id"], c["id"]}
        assert ac_row["status"] == "stale"
        pending_ac = [
            p
            for p in hub.sqlite.list_merge_proposals(status="pending")
            if {p["person_a"], p["person_b"]} == {a["id"], c["id"]}
        ]
        assert len(pending_ac) == 1

        try:
            hub.apply_merge_proposal(int(ab["proposal_id"]))
            raise AssertionError("re-apply must fail")
        except ValueError as e:
            assert "proposal_not_pending" in str(e)

        try:
            hub.apply_merge_proposal(999999)
            raise AssertionError("missing proposal must fail")
        except ValueError as e:
            assert "proposal_not_found" in str(e)

        undo = hub.undo_merge(int(out["merge_log_id"]))
        assert undo["restored_id"] == b["id"]
        assert hub.sqlite.get_person(b["id"])["created_at"] == created_b
        assert hub.sqlite.get_merge_proposal(int(ab["proposal_id"]))["status"] == "undone"

        facts_a2 = {
            str(r["fact"])
            for r in hub.sqlite._conn.execute(
                "SELECT fact FROM person_facts WHERE person_id = ?", (a["id"],)
            )
        }
        facts_b2 = {
            str(r["fact"])
            for r in hub.sqlite._conn.execute(
                "SELECT fact FROM person_facts WHERE person_id = ?", (b["id"],)
            )
        }
        assert facts_a2 == facts_before_a
        assert facts_b2 == facts_before_b

        bc_restored = hub.sqlite.get_merge_proposal(int(bc["proposal_id"]))
        assert bc_restored["status"] == "pending"
        assert {bc_restored["person_a"], bc_restored["person_b"]} == {b["id"], c["id"]}
        ac_restored = hub.sqlite.get_merge_proposal(int(ac["proposal_id"]))
        assert ac_restored["status"] == "pending"
        assert {ac_restored["person_a"], ac_restored["person_b"]} == {a["id"], c["id"]}

        try:
            hub.undo_merge(int(out["merge_log_id"]))
            raise AssertionError("second undo must fail")
        except ValueError as e:
            assert "already_undone" in str(e)

        ok = hub.sqlite.resolve_merge_proposal(int(bc["proposal_id"]), status="rejected")
        assert ok is True
        assert hub.sqlite.resolve_merge_proposal(int(bc["proposal_id"]), status="rejected") is False

        stale_p = hub.propose_people_merge(a["id"], c["id"], reason="stale")
        hub.delete_person(c["id"])
        try:
            hub.apply_merge_proposal(int(stale_p["proposal_id"]))
            raise AssertionError("stale apply must fail")
        except ValueError as e:
            assert "proposal_stale" in str(e)
        assert hub.sqlite.get_merge_proposal(int(stale_p["proposal_id"]))["status"] == "stale"

        # Wipe LTM with missing chroma dir must not fail backup.
        chroma_missing = Path(td) / "no_chroma_here"
        lm = LongTermMemory(
            {"memory": {"rag_enabled": False, "chroma_db_path": str(chroma_missing)}}
        )
        hub2 = MemoryHub(
            {"memory": {"sqlite_path": str(Path(td) / "hub2.db"), "rag_enabled": False}},
            long_memory=lm,
        )
        hub2.add_diary_note("x", source="t")
        w = hub2.wipe(["diary", "journal", "ltm"], backup_dir=Path(td) / "backups2")
        assert w.get("backup")
        assert w.get("chroma_backup") in (None, "")

        # long memory without backup_to must refuse wipe ltm
        class NoBackupLM:
            def clear_all(self) -> int:
                raise AssertionError("clear_all must not run without backup")

        hub3 = MemoryHub(
            {"memory": {"sqlite_path": str(Path(td) / "hub3.db"), "rag_enabled": False}},
            long_memory=NoBackupLM(),  # type: ignore[arg-type]
        )
        try:
            hub3.wipe(["ltm"], backup_dir=Path(td) / "backups3")
            raise AssertionError("wipe without backup_to must fail")
        except RuntimeError as e:
            assert "ltm backup unavailable" in str(e)
        hub3.sqlite.close()

        bak = Path(hub.wipe(["people", "diary", "journal"], backup_dir=Path(td) / "backups")["backup"])
        conn = sqlite3.connect(str(bak))
        try:
            assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] >= 1
        finally:
            conn.close()
    finally:
        if hub is not None:
            try:
                hub.sqlite.close()
            except Exception:
                pass
        if hub2 is not None:
            try:
                hub2.sqlite.close()
            except Exception:
                pass
        td_obj.cleanup()


def _reject_ac_pair_then_undo(*, ac_before_bc: bool, db_name: str) -> None:
    """Reject live A↔C after A←B merge, undo — neither A↔C proposal may return to pending."""
    from core.memory.hub import MemoryHub

    td_obj = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    hub = None
    try:
        hub = MemoryHub(
            {"memory": {"sqlite_path": str(Path(td_obj.name) / db_name), "rag_enabled": False}},
            long_memory=None,
        )
        a = hub.ensure_person_for_account(
            platform="discord", platform_user_id="a1", handle="n", display_name="A"
        )
        b = hub.ensure_person_for_account(
            platform="telegram", platform_user_id="b1", handle="n", display_name="B"
        )
        c = hub.ensure_person_for_account(
            platform="discord", platform_user_id="c1", handle="c", display_name="C"
        )
        ab = hub.propose_people_merge(a["id"], b["id"], reason="ab")
        if ac_before_bc:
            first = hub.propose_people_merge(a["id"], c["id"], reason="ac")
            second = hub.propose_people_merge(b["id"], c["id"], reason="bc")
        else:
            first = hub.propose_people_merge(b["id"], c["id"], reason="bc")
            second = hub.propose_people_merge(a["id"], c["id"], reason="ac")

        out = hub.apply_merge_proposal(int(ab["proposal_id"]))
        r1 = hub.sqlite.get_merge_proposal(int(first["proposal_id"]))
        r2 = hub.sqlite.get_merge_proposal(int(second["proposal_id"]))
        statuses = {r1["status"], r2["status"]}
        assert "pending" in statuses and "stale" in statuses
        live = r1 if r1["status"] == "pending" else r2
        assert {live["person_a"], live["person_b"]} == {a["id"], c["id"]}

        assert hub.sqlite.resolve_merge_proposal(int(live["id"]), status="rejected")
        hub.undo_merge(int(out["merge_log_id"]))

        for pid in (int(first["proposal_id"]), int(second["proposal_id"])):
            st = hub.sqlite.get_merge_proposal(pid)["status"]
            assert st != "pending", (pid, st, "ac_before_bc=", ac_before_bc)
        pending = hub.sqlite.list_merge_proposals(status="pending")
        assert not any({p["person_a"], p["person_b"]} == {a["id"], c["id"]} for p in pending)
    finally:
        if hub is not None:
            try:
                hub.sqlite.close()
            except Exception:
                pass
        td_obj.cleanup()


def test_undo_respects_reject_and_missing_people() -> None:
    """AR 6.1 / 7.1: undo must not revive rejected pairs (both proposal orders) or ghosts."""
    _reject_ac_pair_then_undo(ac_before_bc=False, db_name="hub61.db")
    _reject_ac_pair_then_undo(ac_before_bc=True, db_name="hub61_rev.db")

    from core.memory.hub import MemoryHub

    td_obj2 = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
    td2 = td_obj2.name
    hub = None
    try:
        hub = MemoryHub(
            {"memory": {"sqlite_path": str(Path(td2) / "hub61b.db"), "rag_enabled": False}},
            long_memory=None,
        )
        a = hub.ensure_person_for_account(
            platform="discord", platform_user_id="a2", handle="n2", display_name="A"
        )
        b = hub.ensure_person_for_account(
            platform="telegram", platform_user_id="b2", handle="n2", display_name="B"
        )
        c = hub.ensure_person_for_account(
            platform="discord", platform_user_id="c2", handle="c2", display_name="C"
        )
        ab = hub.propose_people_merge(a["id"], b["id"], reason="ab")
        bc = hub.propose_people_merge(b["id"], c["id"], reason="bc")
        hub.propose_people_merge(a["id"], c["id"], reason="ac")

        out1 = hub.apply_merge_proposal(int(ab["proposal_id"]))
        out2 = hub.apply_merge_proposal(int(bc["proposal_id"]))
        assert hub.sqlite.get_person(c["id"]) is None

        hub.undo_merge(int(out1["merge_log_id"]))
        assert hub.sqlite.get_person(b["id"]) is not None
        assert hub.sqlite.get_person(c["id"]) is None

        for p in hub.sqlite.list_merge_proposals(status="pending"):
            for pid in (p["person_a"], p["person_b"]):
                assert hub.sqlite.get_person(str(pid)) is not None, p
        # Second merge still applied; first undo must not invent A↔C pending for missing C.
        assert hub.sqlite.get_merge_proposal(int(bc["proposal_id"]))["status"] == "applied"
        _ = out2
    finally:
        if hub is not None:
            try:
                hub.sqlite.close()
            except Exception:
                pass
        td_obj2.cleanup()


def main() -> int:
    test_detect_mentions_no_false_max()
    test_speaker_label_nick_not_invented_name()
    test_merge_undo_proposals_lifecycle()
    test_undo_respects_reject_and_missing_people()
    print("OK test_memory_v2_people_offline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
