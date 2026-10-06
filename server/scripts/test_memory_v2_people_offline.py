"""Offline Memory v2: mentions, account resolve, merge, wipe (AR fixes)."""

from __future__ import annotations

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


def test_account_resolve_no_handle_autobind() -> None:
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
        # Same nick, different platform ids → different cards
        assert a["id"] != b["id"]
        assert a["id"] == UnifiedIdentityMapper.resolve("discord", "111")
        assert b["id"] == UnifiedIdentityMapper.resolve("telegram", "222")
        proposals = hub.sqlite.list_merge_proposals(status="pending")
        assert any(p.get("reason", "").startswith("same_handle:") for p in proposals)

        assert hub.find_person("coolni") is None
        assert hub.find_person("oolnick") is None

        # Cyrillic handle_norm (SQLite lower is ASCII-only).
        cyr = hub.ensure_person_for_account(
            platform="discord",
            platform_user_id="333",
            handle="Пупинос",
            display_name="Пупинос",
        )
        assert hub.find_person("пупинос")["id"] == cyr["id"]
        ids = hub.sqlite.find_person_ids_by_handle_norm("ПУПИНОС")
        assert cyr["id"] in ids

        other = hub.ensure_person_for_account(
            platform="discord",
            platform_user_id="999",
            handle="other",
            display_name="Other",
        )
        hub.add_person_fact(a["id"], "зовут Иван", source="test")
        hub.add_person_fact(other["id"], "любит кофе", source="test")
        merged = hub.merge_people(a["id"], other["id"], reason="test")
        assert merged["survivor_id"] == a["id"]
        assert hub.find_person("", discord_id="999")["id"] == a["id"]
        undo = hub.undo_merge(int(merged["merge_log_id"]))
        assert undo["restored_id"] == other["id"]
        assert hub.sqlite.get_person(other["id"]) is not None

        hub.add_diary_note("feeling ok", source="test")
        out = hub.wipe(["people", "diary", "journal"], backup_dir=Path(td) / "backups")
        assert (out.get("deleted") or {}).get("people", 0) >= 1
        assert out.get("backup")
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
    test_account_resolve_no_handle_autobind()
    test_speaker_label_nick_not_invented_name()
    print("OK test_memory_v2_people_offline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
