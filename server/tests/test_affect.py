"""Offline checks for bounded state, scope, lifecycle and talk-only delivery."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import pytest

from core.memory.hub import MemoryHub
from core.memory.sqlite_store import SqliteStore
from offline_support import offline_agent


@pytest.fixture
def hub(tmp_path):
    result = MemoryHub({"memory": {"sqlite_path": str(tmp_path / "memory.db")}})
    yield result
    result.close()


def person(hub, uid="123", name="Same Name"):
    return hub.ensure_person_for_account(platform="discord", platform_user_id=uid, display_name=name)["id"]


def apply(hub, turn="one", uid="123", text="спасибо"):
    return hub.apply_affect_turn(turn_id=turn, discord_id=uid, text=text, generations=hub.affect_generations())


def test_migration_restart_decay_bounds_and_history(hub):
    pid = person(hub)
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    hub.affect.clock = lambda: now
    for i in range(120):
        apply(hub, str(i), text="ты тупая")
    state = hub.affect.snapshot(pid)
    assert state["mood"]["valence"] == pytest.approx(-0.2)
    assert state["mood"]["arousal"] == pytest.approx(0.2)
    assert state["relation"]["affinity"] == -1
    assert state["relation"]["trust"] == 0.5
    assert len(state["relation"]["history"]) == 20
    now += timedelta(hours=8)
    assert hub.affect.snapshot(pid)["mood"]["valence"] == pytest.approx(-0.1)
    # Clock rollback must not amplify state.
    now -= timedelta(hours=9)
    assert hub.affect.snapshot(pid)["mood"]["valence"] == pytest.approx(-0.2)
    other = SqliteStore(hub.sqlite.path)
    other.migrate()
    assert other.schema_version() == 7
    assert other._conn.execute("SELECT affinity FROM person_relations").fetchone()[0] == -1
    other.close()


def test_idempotency_concurrency_and_no_personal_text_in_ledger(hub):
    pid = person(hub)
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: apply(hub, "same-turn", text="спасибо PRIVATE"), range(20)))
    assert sum(results) == 1
    assert hub.affect.snapshot(pid)["relation"]["familiarity"] == pytest.approx(0.01, abs=1e-5)
    row = dict(hub.sqlite._conn.execute("SELECT * FROM affect_turns").fetchone())
    assert set(row) == {"turn_id", "created_at"}
    assert "PRIVATE" not in str(hub.affect.snapshot(pid))


def test_accounts_are_authoritative_and_unknown_does_not_borrow_name(hub):
    p1, p2 = person(hub, "123"), person(hub, "456")
    assert p1 != p2
    apply(hub)
    assert hub.affect_for_account("123")["relation"]["observed"]
    assert not hub.affect_for_account("456")["relation"]["observed"]
    assert hub.affect_for_account("Same Name")["relation"] is None
    assert hub.affect_for_account(None)["relation"] is None
    with pytest.raises(KeyError):
        hub.affect.snapshot("unknown")


@pytest.mark.parametrize("scope", ["mood", "relations", "people"])
def test_wipe_invalidates_inflight_turn_and_keeps_other_scopes(hub, scope):
    pid = person(hub)
    apply(hub)
    generations = hub.affect_generations()
    hub.add_diary_note("Keep diary")
    result = hub.wipe([scope])
    assert scope in result["deleted"]
    assert not hub.apply_affect_turn(turn_id="old-inflight", discord_id="123", text="спасибо", generations=generations)
    assert len(hub.list_diary_notes()) == 1
    if scope != "people":
        state = hub.affect.snapshot(pid)
        assert state["mood"]["valence"] == (0 if scope == "mood" else pytest.approx(0.04, abs=1e-4))
        assert state["relation"]["observed"] == (scope != "relations")
    # Reset must not let a completed turn be applied again.
    assert not apply(hub)
    if scope == "people":
        assert hub.affect_for_account("123")["relation"] is None


def test_single_relation_reset_backup_delete_and_merge_undo(hub, tmp_path):
    p1, p2 = person(hub, "123"), person(hub, "456")
    apply(hub, "a", "123")
    apply(hub, "b", "456", text="ты тупая")
    original = hub.affect.snapshot(p2)["relation"]["affinity"]
    hub.merge_people(survivor_id=p1, source_id=p2, reason="test")
    log = hub.sqlite.list_merge_log(limit=1)[0]
    hub.undo_merge(log["id"])
    assert hub.affect.snapshot(p2)["relation"]["affinity"] == pytest.approx(original, abs=1e-4)
    result = hub.reset_relation(p2, backup_dir=tmp_path / "backups")
    assert result["deleted"]["relations"] == 1
    assert hub.affect.snapshot(p1)["relation"]["observed"]
    assert not hub.affect.snapshot(p2)["relation"]["observed"]
    backup = SqliteStore(result["backup"])
    assert backup._conn.execute("SELECT COUNT(*) FROM person_relations").fetchone()[0] == 2
    backup.close()
    hub.sqlite.delete_person(p1)
    assert hub.sqlite._conn.execute("SELECT COUNT(*) FROM person_relations").fetchone()[0] == 0


def test_relation_wipe_does_not_resurrect_from_merge_snapshot(hub):
    p1, p2 = person(hub, "123"), person(hub, "456")
    apply(hub, uid="456")
    hub.merge_people(survivor_id=p1, source_id=p2, reason="test")
    log = hub.sqlite.list_merge_log(limit=1)[0]
    hub.wipe(["relations"])
    hub.undo_merge(log["id"])
    assert not hub.affect.snapshot(p2)["relation"]["observed"]


@pytest.mark.parametrize("stream", [False, True])
def test_actual_chat_and_stream_update_once_and_only_talk_sees_state(tmp_path, stream):
    agent = offline_agent(tmp_path)
    async def run():
        if stream:
            output = [chunk async for chunk in agent.chat_stream("спасибо", discord_user_id="123", channel_id="77")]
            assert output[-1]["type"] == "done"
        else:
            await agent.chat("спасибо", discord_user_id="123", channel_id="77")
        state = agent.memory_hub.affect_for_account("123")
        assert state["relation"]["familiarity"] == pytest.approx(0.01, abs=1e-5)
        await agent.chat("hello", discord_user_id="123", channel_id="77")
        assert any("[ASSISTANT STATE DATA]" in str(messages) for messages in agent.llm_talk.messages)
        assert "[ASSISTANT STATE DATA]" in str(agent.llm_brain.messages)
        assert "not evidence" in agent.llm_brain.messages[-1][0].content
    try:
        asyncio.run(run())
    finally:
        agent.memory_hub.close()


def test_api_permissions_validation_reset_and_backup(tmp_path):
    from unittest.mock import AsyncMock, MagicMock
    from fastapi.testclient import TestClient
    from core.api.app import build_app
    agent = offline_agent(tmp_path)
    hub = agent.memory_hub
    pid = person(hub)
    apply(hub)
    app = build_app(agent.config, shared_agent=agent,
        shared_monitor=MagicMock(run_once=AsyncMock(return_value={"ok": True})),
        shared_backup_manager=MagicMock(), project_root=tmp_path)
    try:
        with TestClient(app) as client:
            view = {"Authorization": "Bearer offline-viewer-token"}
            admin = {"Authorization": "Bearer offline-admin-token"}
            path = "/v1/memory/affect"
            assert client.get(path).status_code == 401
            assert client.get(path, headers=view).status_code == 200
            assert client.get(path + "?person_id=unknown", headers=view).status_code == 404
            body = {"scope": "relations", "person_id": pid, "confirm": "WIPE"}
            assert client.post(path + "/reset", headers=view, json=body).status_code == 403
            assert client.post(path + "/reset", headers=admin, json=body | {"confirm": "bad"}).status_code == 400
            assert client.post(path + "/reset", headers=admin, json=body | {"scope": "bad"}).status_code == 422
            assert client.post(path + "/reset", headers=admin, json=body | {"scope": "mood"}).status_code == 400
            result = client.post(path + "/reset", headers=admin, json=body)
            assert result.status_code == 200, result.text
            assert result.json()["data"]["backup"]
            assert client.get(path + f"?person_id={pid}", headers=view).json()["data"]["relation"]["observed"] is False
    finally:
        hub.close()


def test_trust_requires_explicit_admission_and_decays_to_baseline(hub):
    pid = person(hub)
    now = datetime(2026, 1, 1, tzinfo=timezone.utc)
    hub.affect.clock = lambda: now
    apply(hub, text="я соврал")
    assert hub.affect.snapshot(pid)["relation"]["trust"] == pytest.approx(0.47)
    apply(hub, "polite", text="спасибо")
    assert hub.affect.snapshot(pid)["relation"]["trust"] == pytest.approx(0.47)
    now += timedelta(days=30)
    assert hub.affect.snapshot(pid)["relation"]["trust"] == pytest.approx(0.485)


def test_migrates_v5_copy_without_touching_existing_memory(tmp_path, monkeypatch):
    import core.memory.sqlite_store as stores
    migrations = stores.MIGRATIONS
    with monkeypatch.context() as patch:
        patch.setattr(stores, "MIGRATIONS", [(v, sql) for v, sql in migrations if v <= 5])
        old = SqliteStore(tmp_path / "v5.db")
        old.upsert_person(person_id="known", display_name="Old card")
        old.add_diary_note(text="Old diary")
        old.backup_to(tmp_path / "migration-copy.db")
        old.close()
    migrated = SqliteStore(tmp_path / "migration-copy.db")
    migrated.migrate()
    assert migrated.schema_version() == 7
    assert migrated.get_person("known")["display_name"] == "Old card"
    assert migrated.list_diary_notes()[0]["text"] == "Old diary"
    migrated.close()


def test_failed_turn_does_not_change_state(tmp_path):
    agent = offline_agent(tmp_path)
    agent.llm_brain.failures = 2
    try:
        asyncio.run(agent.chat("спасибо", discord_user_id="123", channel_id="77"))
        assert agent.memory_hub.affect_for_account("123")["mood"]["updated_at"] is None
    finally:
        agent.memory_hub.close()


def test_compact_talk_state_survives_context_retry_without_history(tmp_path):
    from core.agent.turn_prep import prepare_turn
    from core.agent.talk_messages import build_talk_messages, build_talk_system_prompt
    agent = offline_agent(tmp_path)
    async def run():
        await agent.chat("спасибо", discord_user_id="123", channel_id="77")
        prep = await prepare_turn(agent, user_message="next", username=None, discord_user_id="123", channel_id="77", vision_images=None, author_display_name=None, lyrics_marker="[GET_LYRICS]")
        assert "history" not in str(prep.affect_data)
        for drop in (False, True):
            prompt = build_talk_system_prompt(agent, prep, brain_context="", drop_extra_context=drop)
            messages = build_talk_messages(agent, prep, prompt, user_message="next", vision_images=None, drop_extra_context=drop)
            assert "[ASSISTANT STATE DATA]" in str(messages)
            assert "subjective" not in prep.brain_data
            assert "affinity" in prep.brain_data
    try:
        asyncio.run(run())
    finally:
        agent.memory_hub.close()


@pytest.mark.parametrize("stream", [False, True])
def test_fast_path_updates_familiarity_without_llm(tmp_path, stream):
    agent = offline_agent(tmp_path)
    agent.config["agent"]["fast_path"] = {"enabled": True}
    async def run():
        if stream:
            result = [chunk async for chunk in agent.chat_stream("включи свет", discord_user_id="123", channel_id="77")]
            assert result[-1]["fast_path"]
        else:
            result = await agent.chat("включи свет", discord_user_id="123", channel_id="77")
            assert result["model_trace"]["without_llm"]
        assert agent.memory_hub.affect_for_account("123")["relation"]["observed"]
        assert not agent.llm_talk.messages
        assert not agent.llm_brain.messages
    try:
        asyncio.run(run())
    finally:
        agent.memory_hub.close()


def test_reset_during_actual_generation_cannot_repopulate_state(tmp_path):
    from langchain_core.messages import AIMessage
    agent = offline_agent(tmp_path)
    async def run():
        started, proceed = asyncio.Event(), asyncio.Event()
        async def respond(messages):
            started.set()
            await proceed.wait()
            return AIMessage(content="fresh response")
        agent.llm_talk.ainvoke = respond
        task = asyncio.create_task(agent.chat("спасибо", discord_user_id="123", channel_id="77"))
        await started.wait()
        agent.memory_hub.wipe(["mood", "relations"])
        proceed.set()
        await task
        state = agent.memory_hub.affect_for_account("123")
        assert state["mood"]["updated_at"] is None
        assert not state["relation"]["observed"]
    try:
        asyncio.run(run())
    finally:
        agent.memory_hub.close()


def test_undo_keeps_new_relation_on_recreated_source_card(hub):
    p1, p2 = person(hub, "123"), person(hub, "456")
    apply(hub, uid="456")
    hub.merge_people(survivor_id=p1, source_id=p2, reason="test")
    log = hub.sqlite.list_merge_log(limit=1)[0]
    hub.wipe(["relations"])
    hub.sqlite.upsert_person(person_id=p2, display_name="Recreated card")
    hub.affect.apply_turn(turn_id="new-source-turn", person_id=p2, text="ты тупая")
    before = hub.affect.snapshot(p2)["relation"]["affinity"]
    hub.undo_merge(log["id"])
    assert hub.affect.snapshot(p2)["relation"]["affinity"] == pytest.approx(before, abs=1e-4)
