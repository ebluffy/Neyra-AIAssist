"""Offline Memory v2: mentions, account resolve, merge, wipe."""

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
    # substring inside a longer word must NOT hit
    assert detect_mentioned_names("максимум настроения сегодня", name_map) == []
    # exact + short Russian case ending on full alias OK
    assert detect_mentioned_names("привет, макс!", name_map) == ["p_max"]
    assert detect_mentioned_names("видел Макса вчера", name_map) == ["p_max"]
    assert detect_mentioned_names("пупинос зашёл", name_map) == ["p_pup"]


def test_account_resolve_merge_wipe() -> None:
    from core.memory.hub import MemoryHub
    from core.runtime.identity import UnifiedIdentityMapper

    with tempfile.TemporaryDirectory() as td:
        db = Path(td) / "hub.db"
        cfg = {"memory": {"sqlite_path": str(db), "rag_enabled": False}}
        hub = MemoryHub(cfg, long_memory=None)

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
        # same handle → bind to existing
        assert a["id"] == b["id"]
        assert hub.find_person("", discord_id="111")["id"] == a["id"]

        other = hub.ensure_person_for_account(
            platform="discord",
            platform_user_id="999",
            handle="other",
            display_name="Other",
        )
        assert other["id"] != a["id"]
        hub.add_person_fact(a["id"], "зовут Иван", source="test")
        hub.add_person_fact(other["id"], "любит кофе", source="test")

        # fuzzy / substring must not match (exact handle/display only)
        assert hub.find_person("coolni") is None
        assert hub.find_person("oolnick") is None

        merged = hub.merge_people(a["id"], other["id"], reason="test")
        assert merged["survivor_id"] == a["id"]
        assert hub.find_person("", discord_id="999")["id"] == a["id"]
        facts = [f["fact"] for f in hub.list_person_facts(a["id"], limit=20)]
        assert any("Иван" in x for x in facts)
        assert any("кофе" in x for x in facts)

        hub.add_diary_note("feeling ok", source="test")
        hub.add_journal_entry("day summary", title="t", kind="test")
        w = hub.wipe(["people", "diary", "journal"])
        assert w.get("people", 0) >= 1
        assert w.get("diary", 0) >= 1
        assert w.get("journal", 0) >= 1
        assert hub.list_people() == []

        # opaque id = uuid5
        pid = UnifiedIdentityMapper.resolve("discord", "111")
        again = hub.ensure_person_for_account(platform="discord", platform_user_id="111", handle="x")
        assert again["id"] == pid
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
        assert "Пупинос" in label or "pupinos" in label.lower()
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
    test_account_resolve_merge_wipe()
    test_speaker_label_nick_not_invented_name()
    print("OK test_memory_v2_people_offline")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
