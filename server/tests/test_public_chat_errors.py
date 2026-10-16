"""Provider failures stay diagnostic-only across the real stream and WS pipeline."""

import asyncio
import json
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

from core.api.app import build_app
from core.text_resources import message_text
from offline_support import offline_agent


@pytest.mark.parametrize("stage,transport", [
    (stage, transport)
    for stage in ("brain", "talk", "overflow_retry")
    for transport in ("stream", "ws", "chat", "rest")
    if stage != "overflow_retry" or transport in ("stream", "ws")
])
def test_provider_error_never_reaches_public_output(tmp_path, transport, stage):
    agent = offline_agent(tmp_path)
    private = "PRIVATE-UPSTREAM-DETAIL https://gateway.invalid/v1 request_id=private"
    if stage == "brain":
        agent.llm_brain.errors = [RuntimeError(private)]
    else:
        errors = [RuntimeError(private), RuntimeError(private)]
        if stage == "overflow_retry":
            errors = [RuntimeError("context_length_exceeded")] * 2 + errors
        agent.llm_talk.errors = errors
    failed = MagicMock()
    agent._publish_chat_turn_failed = failed
    expected = message_text("brain.unavailable" if stage == "brain" else "reply.failed")
    try:
        if transport in ("stream", "chat"):
            async def collect():
                return [chunk async for chunk in agent.chat_stream("hello")]

            if transport == "stream":
                output = asyncio.run(collect())
                error = output[-1]
            else:
                error = asyncio.run(agent.chat("hello"))
                output = [error]
            assert error["text"] == expected
            assert error["code"] == ("brain_unavailable" if stage == "brain" else "generation_failed")
        else:
            app = build_app(
                agent.config, shared_agent=agent, project_root=tmp_path,
                shared_monitor=MagicMock(run_once=AsyncMock(return_value={"ok": True})),
                shared_backup_manager=MagicMock(),
            )
            with TestClient(app) as client:
                headers = {"Authorization": "Bearer offline-admin-token"}
                if transport == "rest":
                    response = client.post("/v1/chat", headers=headers, json={"text": "hello"})
                    assert response.status_code == 200
                    error = response.json()["data"]
                    output = [response.json()]
                    assert error["text"] == expected
                else:
                    with client.websocket_connect("/v1/ws/chat", headers=headers) as ws:
                        assert ws.receive_json()["type"] == "hello"
                        ws.send_json({"type": "chat", "text": "hello"})
                        error = ws.receive_json()
                        output = [error]
                        assert error["type"] == "error"
                        assert error["message"] == expected
                        assert error["code"] == "chat_error"
        assert "PRIVATE-UPSTREAM-DETAIL" not in json.dumps(output)
        assert error["model_trace"]["status"] == "failed"
        failed.assert_called_once()
        assert private in failed.call_args.kwargs["error"]
        attempts = {"brain": 0, "talk": 2, "overflow_retry": 4}[stage]
        if stage == "talk" and transport in ("chat", "rest"):
            attempts = 1
        assert len(agent.llm_talk.messages) == attempts
        assert not agent.memory_hub.list_chat(limit=10)
    finally:
        agent.memory_hub.close()


@pytest.mark.parametrize('completed', [False, True])
def test_slash_errors_are_fixed_and_ephemeral(tmp_path, completed, caplog):
    import discord
    from modules.discord.bot import NeyraDiscordBot
    agent = offline_agent(tmp_path)
    async def run():
        bot = NeyraDiscordBot(agent, agent.config)
        bot.tree.sync = AsyncMock(return_value=[])
        await bot.setup_hook()
        interaction = NS(response=NS(is_done=lambda: completed, send_message=AsyncMock()), followup=NS(send=AsyncMock()))
        await bot.tree.on_error(interaction, discord.app_commands.AppCommandError('PRIVATE-SLASH-DETAIL'))
        call = (interaction.followup.send if completed else interaction.response.send_message).call_args
        assert 'PRIVATE' not in call.args[0]
        assert call.kwargs['ephemeral'] is True
        await bot.close()
    asyncio.run(run())
    assert 'PRIVATE-SLASH-DETAIL' in caplog.text
    agent.memory_hub.close()
