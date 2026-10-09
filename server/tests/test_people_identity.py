"""People identity: opaque ids, no nick-as-id, account bind conflicts, merge proposals."""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

SERVER_ROOT = Path(__file__).resolve().parent.parent
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))

_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I
)


@pytest.fixture()
def hub(tmp_path: Path):
    from core.memory.hub import MemoryHub

    h = MemoryHub(
        {"memory": {"sqlite_path": str(tmp_path / "hub.db"), "rag_enabled": False}},
        long_memory=None,
    )
    yield h
    h.sqlite.close()


def test_allocate_person_id_never_nick_slug(hub):
    pid = hub.allocate_person_id(explicit_id="hopelesness")
    assert _UUID.match(pid)
    assert pid != "hopelesness"


def test_allocate_from_discord_account(hub):
    from core.runtime.identity import UnifiedIdentityMapper

    pid = hub.allocate_person_id(
        accounts=[{"platform": "discord", "platform_user_id": "999888777"}]
    )
    assert pid == UnifiedIdentityMapper.resolve("discord", "999888777")


def test_ensure_then_slug_create_proposes_merge(hub):
    """Discord uuid5 person + legacy slug card with same handle → merge proposal."""
    a = hub.ensure_person_for_account(
        platform="discord",
        platform_user_id="111222333",
        handle="hopelesness",
        display_name="Hopeless",
    )
    assert _UUID.match(a["id"])
    # Legacy dashboard-style slug card (simulate old bug).
    hub.upsert_person("hopelesness", display_name="Hopeless", aliases=["hopelesness"])
    dupes = hub.find_slug_duplicates()
    assert any(d["slug_person_id"] == "hopelesness" for d in dupes)
    related = next(d for d in dupes if d["slug_person_id"] == "hopelesness")
    assert a["id"] in related["related_person_ids"]


def test_account_bind_conflict_no_steal(hub):
    from core.memory.sqlite_store import AccountBoundConflict
    from core.runtime.identity import UnifiedIdentityMapper

    pid = UnifiedIdentityMapper.resolve("discord", "444")
    hub.ensure_person_for_account(
        platform="discord", platform_user_id="444", handle="alpha", display_name="A"
    )
    other = hub.allocate_person_id()
    hub.upsert_person(other, display_name="Other", aliases=["other"])
    with pytest.raises(AccountBoundConflict) as ei:
        hub.sqlite.upsert_person_account(
            person_id=other,
            platform="discord",
            platform_user_id="444",
            handle="alpha",
        )
    assert ei.value.existing_person_id == pid


def test_two_discord_accounts_stay_separate_until_merge(hub):
    from core.runtime.identity import UnifiedIdentityMapper

    a = hub.ensure_person_for_account(
        platform="discord", platform_user_id="101", handle="ebluffy", display_name="Дима"
    )
    b = hub.ensure_person_for_account(
        platform="discord", platform_user_id="202", handle="dima_alt", display_name="Дима"
    )
    assert a["id"] != b["id"]
    assert a["id"] == UnifiedIdentityMapper.resolve("discord", "101")
    assert b["id"] == UnifiedIdentityMapper.resolve("discord", "202")
    # Same display name must NOT auto-merge.
    people = hub.list_people()
    assert len(people) >= 2


def test_save_dossier_conflict_creates_proposal(hub):
    from core.runtime.identity import UnifiedIdentityMapper

    pid = UnifiedIdentityMapper.resolve("discord", "555")
    hub.ensure_person_for_account(
        platform="discord", platform_user_id="555", handle="nick", display_name="N"
    )
    other = hub.allocate_person_id()
    out = hub.save_person_dossier(
        person_id=other,
        names=["Nick"],
        discord_ids=["555"],
        create=True,
    )
    assert out.get("account_conflicts")
    props = hub.sqlite.list_merge_proposals(status="pending")
    assert any(
        {p["person_a"], p["person_b"]} == {pid, other} for p in props
    )


def test_api_create_rejects_slug_as_id(client, auth_headers, stub_agent, monkeypatch, tmp_path):
    """POST /v1/memory/people with id=hopelesness must still store opaque UUID."""
    from core.memory.hub import MemoryHub

    hub = MemoryHub(
        {"memory": {"sqlite_path": str(tmp_path / "api_hub.db"), "rag_enabled": False}},
        long_memory=None,
    )
    stub_agent.memory_hub = hub
    stub_agent.people_db = None
    try:
        r = client.post(
            "/v1/memory/people",
            headers=auth_headers["admin"],
            json={"id": "hopelesness", "names": ["Hopeless"]},
        )
        assert r.status_code == 200, r.text
        pid = ((r.json().get("data") or {}).get("person") or {}).get("id")
        assert pid and _UUID.match(str(pid))
        assert str(pid) != "hopelesness"
        # Nick kept as alias
        names = ((r.json().get("data") or {}).get("person") or {}).get("names") or []
        assert "hopelesness" in [str(n).casefold() for n in names] or "Hopeless" in names
    finally:
        hub.sqlite.close()
