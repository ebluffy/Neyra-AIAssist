"""Offline acceptance of prompt boundaries, scoped memory and detached job evidence."""

import asyncio
from types import SimpleNamespace as NS

import pytest
from langchain_core.messages import AIMessage, AIMessageChunk

from core.agent.model_trace import ACTIVE_TRACE, TurnTrace, finish
from core.plugins.builder import coder_connection
from offline_support import offline_agent


@pytest.mark.parametrize("explicit", [False, True])
def test_coder_uses_layered_provider_and_model(monkeypatch, explicit):
    monkeypatch.setenv("AIHOPE_API_KEY", "hope-key")
    monkeypatch.setenv("OPENROUTER_API_KEY", "wrong-provider-key")
    config = {"llm": {"brain_model": {"provider": "aihope", "model": "brain-id"},
                      "providers": {"aihope": {"base_url": "https://gateway.test/v1"}}}}
    if explicit:
        config["llm"]["coder_model"] = {"provider": "aihope", "model": "coder-id"}
    settings, key = coder_connection(config)
    assert settings.provider == "aihope"
    assert settings.base_url == "https://gateway.test/v1"
    assert settings.model == ("coder-id" if explicit else "brain-id")
    assert key == "hope-key"
    with pytest.raises(ValueError):
        coder_connection({})


def test_scoped_history_and_diary_do_not_cross_users_or_channels(tmp_path):
    agent = offline_agent(tmp_path)
    uid = agent.identity.resolve_from_discord("123")
    agent.config["memory"]["pre_context"] = {"enabled": True, "sources": ["diary"], "inject_lane": "both"}
    agent.memory_hub.add_diary_note("private-diary", owner_id=uid, channel_id="77")

    async def run():
        await agent.chat("private-first-turn", discord_user_id="123", channel_id="77")
        await agent.chat("different-user", discord_user_id="456", channel_id="77")
        other_user = str(agent.llm_talk.messages[-1])
        assert "private-first-turn" not in other_user
        assert "private-diary" not in other_user
        await agent.chat("different-channel", discord_user_id="123", channel_id="88")
        assert "private-diary" not in str(agent.llm_talk.messages[-1])
        await agent.chat("same-user-channel", discord_user_id="123", channel_id="77")
        own_messages = next(messages for messages in reversed(agent.llm_talk.messages)
                            if any("[TURN CONTEXT DATA]" in str(m.content) for m in messages))
        assert "private-first-turn" in str(own_messages)
        assert "private-diary" in str(own_messages)
        assert "private-diary" not in own_messages[0].content
    asyncio.run(run())
    agent.memory_hub.close()


@pytest.mark.parametrize("wipe", [None, "diary", "journal", "working_memory", "ltm"])
def test_diary_is_detached_scoped_and_cannot_repopulate_after_wipe(tmp_path, wipe):
    agent = offline_agent(tmp_path)
    agent.config["memory"]["diary_after_turn"] = True
    agent.llm_memory = NS()

    async def run():
        started, proceed = asyncio.Event(), asyncio.Event()
        async def generate(messages):
            assert "first person" in messages[0].content or "first-person" in messages[0].content
            assert "Do not act as an outside narrator" in messages[0].content
            started.set()
            await proceed.wait()
            return AIMessage(content="Я ответила на вопрос и сохранила договорённость.",
                             response_metadata={"model_name": "reported-memory", "request_id": "request-memory"},
                             usage_metadata={"input_tokens": 20, "output_tokens": 10, "total_tokens": 30})
        agent.llm_memory.ainvoke = generate
        agent.llm_memory.bind = lambda **kwargs: agent.llm_memory
        output = await agent.chat("hello", discord_user_id="123", channel_id="77")
        await started.wait()
        original_report = output["model_trace"]
        assert original_report["kind"] == "turn"
        assert not any(c["lane"] == "memory" for c in original_report["calls"])
        if wipe:
            agent.memory_hub.wipe([wipe])
        proceed.set()
        await asyncio.gather(*list(agent._background_jobs), return_exceptions=True)
        reports = agent.model_activity.recent()
        background = next(row for row in reports if row["kind"] == "background")
        assert background["parent_turn_id"] == original_report["turn_id"]
        assert background["calls"][0]["provider_request_id"] == "request-memory"
        assert background["tasks"][0]["status"] == ("cancelled" if wipe == "diary" else "completed")
        assert agent.model_activity.for_owner("123", "77") == original_report
        notes = agent.memory_hub.list_diary_notes(owner_id=agent.identity.resolve_from_discord("123"), channel_id="77")
        assert len(notes) == (0 if wipe == "diary" else 1)
        if notes:
            assert notes[0]["source"] == "turn_diary"
            assert notes[0]["text"].startswith("Я ")
    asyncio.run(run())
    agent.memory_hub.close()


def test_streaming_collects_trailing_usage_and_waits_for_content(tmp_path):
    agent = offline_agent(tmp_path)
    async def stream(messages):
        yield AIMessageChunk(content="", response_metadata={"request_id": "provider-123"})
        yield AIMessageChunk(content="Ответ")
        yield AIMessageChunk(content="", response_metadata={"model_name": "reported-stream"},
                             usage_metadata={"input_tokens": 100, "output_tokens": 5, "total_tokens": 105,
                                             "input_token_details": {"cache_read": 60}})
    agent.llm_talk.astream = stream
    async def run():
        chunks = [chunk async for chunk in agent.chat_stream("hello")]
        report = chunks[-1]["model_trace"]
        call = next(c for c in report["calls"] if c["purpose"] == "stream_reply")
        assert call["provider_request_id"] == "provider-123"
        assert call["reported_model"] == "reported-stream"
        assert call["usage"]["input_tokens"] == 100
        assert call["usage"]["cache_read_tokens"] == 60
        assert call["first_meaningful_token_ms"] is not None
    asyncio.run(run())
    agent.memory_hub.close()


def test_persona_reaches_talk_but_not_brain_or_context_data(tmp_path):
    agent = offline_agent(tmp_path)
    agent.config["assistant"].update(system_prompt="PERSONA-SENTINEL", persona_in_brain=True)
    asyncio.run(agent.chat("test"))
    assert "PERSONA-SENTINEL" in agent.llm_talk.messages[0][0].content
    assert "PERSONA-SENTINEL" not in str(agent.llm_brain.messages)
    assert "BRAIN FACTS" in str(agent.llm_talk.messages[0])
    agent.memory_hub.close()


def test_final_trace_is_persisted_and_does_not_resurrect_wiped_chat(tmp_path):
    agent = offline_agent(tmp_path)
    output = asyncio.run(agent.chat("hello", discord_user_id="123", channel_id="77"))
    report = output["model_trace"]
    rows = agent.memory_hub.list_chat(limit=10)
    assert rows and all(row["meta"]["model_trace"] == report for row in rows)
    agent.memory_hub.wipe(["chat_log"])
    agent.memory_hub.sqlite.update_turn_trace(report["turn_id"], report)
    assert agent.memory_hub.list_chat(limit=10) == []
    agent.memory_hub.close()


def test_background_cancellation_failure_and_response_ids(tmp_path):
    from core.agent.model_trace import spawn_background, invoke
    agent = offline_agent(tmp_path)
    async def run():
        async def fail():
            raise RuntimeError("private exception text")
        async def delayed():
            await asyncio.sleep(10)
        await spawn_background(agent, "failure", fail)
        pending = spawn_background(agent, "cancel-before-start", delayed)
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        await asyncio.sleep(0)
        statuses = {r["status"] for r in agent.model_activity.recent()}
        assert statuses == {"failed", "cancelled"}
        trace = TurnTrace("123", "77", agent.config)
        token = ACTIVE_TRACE.set(trace)
        try:
            model = NS(ainvoke=lambda messages: asyncio.sleep(0, result=AIMessage(content="ok", response_metadata={"id": "completion-only"})))
            await invoke(agent, model, [], lane="talk", purpose="id-test")
            assert trace.calls[0]["provider_request_id"] is None
            assert trace.calls[0]["provider_response_id"] == "completion-only"
            finish(agent, trace)
        finally:
            ACTIVE_TRACE.reset(token)
    asyncio.run(run())
    assert "private exception text" not in str(agent.model_activity.recent())
    agent.memory_hub.close()


def test_memory_layer_routes_require_maint_and_show_actual_scoped_data(tmp_path):
    from fastapi.testclient import TestClient
    from core.api.app import build_app
    from unittest.mock import AsyncMock, MagicMock
    agent = offline_agent(tmp_path)
    asyncio.run(agent.chat("scoped-message", discord_user_id="123", channel_id="77"))
    with TestClient(build_app(agent.config, shared_agent=agent, shared_monitor=MagicMock(run_once=AsyncMock(return_value={"ok": True})), shared_backup_manager=MagicMock(), project_root=tmp_path)) as client:
        for path in ("/v1/memory/short", "/v1/memory/long"):
            assert client.get(path).status_code == 401
            assert client.get(path, headers={"Authorization": "Bearer offline-viewer-token"}).status_code == 403
            assert client.get(path, headers={"Authorization": "Bearer offline-maint-token"}).status_code == 200
        windows = client.get("/v1/memory/short", headers={"Authorization": "Bearer offline-admin-token"}).json()["data"]["windows"]
        assert windows[0]["channel_id"] == "77"
        assert windows[0]["messages"][0]["content"].endswith("scoped-message")
        debug = client.get("/v1/debug/memory", headers={"Authorization": "Bearer offline-maint-token"}).json()["data"]
        assert debug["short_term_windows"] == windows
        assert any("scoped-message" in m["content"] for m in debug["short_term_messages"])
    agent.memory_hub.close()


def test_reflection_does_not_resolve_ambiguous_display_names(tmp_path):
    from core.reflection.engine import ReflectionEngine
    agent = offline_agent(tmp_path)
    asyncio.run(agent.chat("first", username="same", discord_user_id="123"))
    asyncio.run(agent.chat("second", username="same", discord_user_id="456"))
    engine = ReflectionEngine.__new__(ReflectionEngine)
    engine.agent = agent
    people = agent.memory_hub.list_people()
    assert len(people) == 2
    engine._apply_reflection_result({"people_updates": [{"person_hint": "same", "fact": "Пользователь работает разработчиком и изучает Python."}]})
    assert not any(agent.memory_hub.list_person_facts(p["id"]) for p in people)
    engine._apply_reflection_result({"people_updates": [{"person_hint": people[0]["id"], "fact": "Пользователь работает разработчиком и изучает Python."}]})
    assert len(agent.memory_hub.list_person_facts(people[0]["id"])) == 1
    assert agent.memory_hub.list_person_facts(people[1]["id"]) == []
    assert agent.memory_hub.list_diary_notes() == []
    assert agent.memory_hub.list_journal_entries()
    agent.memory_hub.close()


@pytest.mark.parametrize("empty", [False, True])
def test_ltm_consolidation_keeps_owner_and_retains_sources_on_empty_result(tmp_path, empty):
    from core.memory.ltm_maintenance import _legacy_execute_ltm_summarize
    writes, archives, prompts = [], [], []
    async def summarize(text, **kwargs):
        prompts.append(text)
        return "" if empty else f"digest: {text}"
    agent = NS(summarize_ltm_corpus=summarize, long_memory=NS(
        add_knowledge=lambda text, meta: (writes.append((text, meta)) or (True, str(len(writes)))),
        archive_older_than=lambda *args, **kwargs: (archives.append(True) or {"archived": 2}),
    ))
    rows = [("1", {"user_id": "a"}, "private-a"), ("2", {"user_id": "b"}, "private-b")]
    async def run():
        return await _legacy_execute_ltm_summarize(agent, {}, tmp_path, rows=rows, older_than_days=30, types=None, max_entries=20, compress_with_llm=True, digest_source="test")
    if empty:
        with pytest.raises(RuntimeError, match="source records retained"):
            asyncio.run(run())
        assert not archives
    else:
        assert asyncio.run(run())["archived"] == 2
        assert len(prompts) == 2 and all(not ("private-a" in p and "private-b" in p) for p in prompts)
        assert {m["user_id"] for _, m in writes} == {"a", "b"}


def test_metadata_only_stream_does_not_disable_first_text_timeout(tmp_path):
    from core.agent.llm_stream import astream_text_with_fallback
    agent = offline_agent(tmp_path)
    agent.primary_first_token_timeout = 0.1
    async def stream(messages):
        while True:
            yield AIMessageChunk(content="", response_metadata={"model_name": "metadata-only"})
            await asyncio.sleep(0.02)
    agent.llm_talk.astream = stream
    async def run():
        trace = TurnTrace(None, None, agent.config)
        token = ACTIVE_TRACE.set(trace)
        try:
            with pytest.raises(asyncio.TimeoutError):
                async for _ in astream_text_with_fallback(agent, []):
                    pytest.fail("Metadata must not be emitted as answer text")
            assert len(trace.calls) == 2
            assert all(c["status"] == "failed" and c["first_meaningful_token_ms"] is None for c in trace.calls)
            assert [c["retry_layer"] for c in trace.calls] == [None, "stream_timeout"]
            assert all(c["error_class"] == "TimeoutError" for c in trace.calls)
            finish(agent, trace, "failed")
        finally:
            ACTIVE_TRACE.reset(token)
    asyncio.run(run())
    agent.memory_hub.close()


def test_existing_schema_migrates_without_assigning_legacy_notes_to_users(tmp_path):
    import sqlite3
    from core.memory.migrations import MIGRATIONS
    from core.memory.sqlite_store import SqliteStore
    path = tmp_path / "old.sqlite"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
        for version, sql in MIGRATIONS:
            if version >= 5:
                break
            connection.executescript(sql)
            connection.execute("INSERT INTO schema_migrations VALUES (?, '2026-01-01')", (version,))
        connection.execute("INSERT INTO diary_notes (ts, text, source) VALUES ('2026-01-01', 'legacy-note', 'manual')")
    store = SqliteStore(path)
    store.migrate()
    assert store.list_diary_notes()[0]["text"] == "legacy-note"
    assert store.list_diary_notes(owner_id="arbitrary-new-user") == []
    store.close()
