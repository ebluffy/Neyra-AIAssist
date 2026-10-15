"""Offline regressions for PR #27 automatic review AR-7 through AR-11."""

import asyncio
import json
from unittest.mock import MagicMock

import pytest

from core.agent.discord_context import context_prompt, DiscordUser
from core.agent.model_trace import ACTIVE_TRACE
from core.api.app import build_app
from offline_support import offline_agent
from test_stage3a import discord_message
from core.agent.discord_context import context_from_message


@pytest.mark.parametrize("harness", ["pytest", "e2e"])
def test_harness_ignores_inherited_runtime_directory(tmp_path, monkeypatch, api_config, stub_agent, harness):
    inherited = tmp_path / "live-data"
    inherited.mkdir()
    marker = inherited / "dashboard_auth.sqlite"
    marker.write_bytes(b"existing-private-database")
    monkeypatch.setenv("NEYRA_DATA_DIR", str(inherited))
    root = tmp_path / "isolated"
    root.mkdir()
    if harness == "e2e":
        from scripts.dashboard_e2e import create_app
        app = create_app(root)
        expected = root / "data" / "dashboard_auth.sqlite"
    else:
        from conftest import isolate_runtime_data
        isolate_runtime_data.__wrapped__(monkeypatch)
        app = build_app(api_config, shared_agent=stub_agent, shared_monitor=MagicMock(),
                        shared_backup_manager=MagicMock(), project_root=root)
        expected = tmp_path / "data" / "dashboard_auth.sqlite"
    assert app.state.dashboard_auth.path == expected
    assert expected.is_file()
    assert marker.read_bytes() == b"existing-private-database"
    if harness == "e2e":
        app.state.agent.memory_hub.close()


def test_context_metadata_is_bounded_and_independent_of_message_content():
    message = discord_message()
    context = context_from_message(message, "999")
    large = context.model_copy(update={"message": context.message.model_copy(update={
        "content": "private payload " * 300,
        "mentions": [DiscordUser(id=str(i), display_name="untrusted name") for i in range(100)],
    })})
    metadata = context_prompt(large)
    same = large.model_copy(update={"message": large.message.model_copy(update={"content": "short"})})
    assert metadata == context_prompt(same)
    payload = json.loads(metadata.split("\n")[-1])
    assert "content" not in payload["message"]
    assert len(payload["message"]["mentions"]) == 10


def test_rest_turn_cancellation_is_recorded_and_trace_reset(tmp_path):
    agent = offline_agent(tmp_path)
    events = []
    agent.event_bus.subscribe("llm.turn.completed", lambda event: events.append(event.payload))

    async def run():
        started = asyncio.Event()

        async def pending(messages):
            started.set()
            await asyncio.Event().wait()

        agent.llm_brain.ainvoke = pending
        task = asyncio.create_task(agent.chat("hello", discord_user_id="123", channel_id="77"))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert ACTIVE_TRACE.get() is None

    asyncio.run(run())
    report = agent.model_activity.for_owner("123", "77")
    assert report["status"] == "cancelled"
    assert all(call["status"] != "running" for call in report["calls"])
    assert events == [report]
    agent.memory_hub.close()


@pytest.mark.parametrize("failure", ["persist", "rebind"])
def test_config_errors_do_not_expose_exception_details(client, auth_headers, stub_agent, monkeypatch, caplog, failure):
    secret_detail = "private-provider-key /private/runtime/config.yaml"

    def fail(*args, **kwargs):
        raise RuntimeError(secret_detail)

    if failure == "persist":
        monkeypatch.setattr("core.runtime.config_loader.persist_allowlisted_updates", fail)
    else:
        stub_agent._setup_llm.side_effect = fail
    response = client.post("/v1/config/update", json={"updates": {"llm.talk_model.model": "offline"}},
                           headers=auth_headers["admin"])
    assert response.status_code == 500
    assert secret_detail not in response.text
    assert secret_detail in caplog.text
    assert response.headers["x-trace-id"] in caplog.text
