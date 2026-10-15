from pathlib import Path

import pytest

from core.memory.sqlite_store import SqliteStore


def test_diary_scope_dedupe_and_reopen(tmp_path: Path) -> None:
    db_path = tmp_path / "memory.sqlite3"
    store = SqliteStore(str(db_path))
    first = store.add_diary_note(
        text="first", owner_id="owner-a", channel_id="channel-a",
        provenance="chat", freshness="fresh", dedupe_key="turn-1",
    )
    assert store.add_diary_note(
        text="retry", owner_id="owner-a", channel_id="channel-a", dedupe_key="turn-1",
    ) == first
    assert store.list_diary_notes(owner_id="owner-b", channel_id="channel-a") == []
    store.close()

    reopened = SqliteStore(str(db_path))
    notes = reopened.list_diary_notes(owner_id="owner-a", channel_id="channel-a")
    assert len(notes) == 1
    assert notes[0]["text"] == "retry"
    assert notes[0]["provenance"] == "chat"


def test_journal_delete_respects_scope(tmp_path: Path) -> None:
    store = SqliteStore(str(tmp_path / "memory.sqlite3"))
    entry_id = store.add_journal_entry(
        title="reflection", text="durable", owner_id="owner-a", channel_id="channel-a",
        provenance="reflection", freshness="current",
    )
    assert not store.delete_journal_entry(entry_id, owner_id="owner-b", channel_id="channel-a")
    assert store.list_journal_entries(owner_id="owner-a", channel_id="channel-a")[0]["id"] == entry_id
    assert store.delete_journal_entry(entry_id, owner_id="owner-a", channel_id="channel-a")
    assert store.list_journal_entries(owner_id="owner-a", channel_id="channel-a") == []


@pytest.mark.parametrize("section", ["diary", "journal"])
def test_api_delete_is_admin_global_even_for_scoped_entries(tmp_path, section):
    from unittest.mock import AsyncMock, MagicMock
    from fastapi.testclient import TestClient
    from core.api.app import build_app
    from offline_support import offline_agent

    agent = offline_agent(tmp_path)
    hub = agent.memory_hub
    if section == "diary":
        entry_id = hub.add_diary_note(text="private note", owner_id="owner-a", channel_id="channel-a")
    else:
        entry_id = hub.add_journal_entry(text="private event", owner_id="owner-a", channel_id="channel-a")
    app = build_app(agent.config, shared_agent=agent,
                    shared_monitor=MagicMock(run_once=AsyncMock(return_value={"ok": True})),
                    shared_backup_manager=MagicMock(), project_root=tmp_path)
    try:
        with TestClient(app) as client:
            path = f"/v1/memory/{section}/{entry_id}"
            for role in ("viewer", "maint"):
                assert client.delete(path, headers={"Authorization": f"Bearer offline-{role}-token"}).status_code == 403
            response = client.delete(path, headers={"Authorization": "Bearer offline-admin-token"})
            assert response.status_code == 200
            assert response.json()["data"]["deleted"]
            assert client.delete(path, headers={"Authorization": "Bearer offline-admin-token"}).status_code == 404
    finally:
        hub.close()
