"""Real offline turns: Discord identity/context and model evidence across APIs."""

import asyncio
import json
from types import SimpleNamespace as NS

import pytest
from fastapi.testclient import TestClient

from core.agent.discord_context import context_from_message
from core.agent.model_trace import ACTIVE_TRACE, TurnTrace, ModelActivity
from core.api.app import build_app
from offline_support import offline_agent, OfflineModel


@pytest.mark.parametrize("with_history", [False, True])
@pytest.mark.parametrize("drop_extra", [False, True])
def test_talk_message_list_keeps_discord_metadata_in_human_role(with_history, drop_extra):
    from core.agent.discord_context import DiscordContext
    from core.agent.talk_messages import build_talk_messages
    from langchain_core.messages import HumanMessage, SystemMessage

    context = DiscordContext.model_validate({
        "current_user": {"id": "u1", "handle": "alice"},
        "channel": {"id": "c1", "type": "text"},
        "message": {"id": "m1", "content": "hello"},
        "addressed_to_bot": True,
        "response_target": {"channel_id": "c1", "message_id": "m1"},
    })
    history = [{"role": "user", "content": "old"}] if with_history else []
    agent = NS(short_memory=NS(get_history=lambda: history))
    agent._make_human_turn = lambda text, *args, **kwargs: HumanMessage(content=text)
    agent._maybe_append_micro_plan_prefill = lambda messages, **kwargs: messages
    prep = NS(discord_context=context, talk_vm=None, speaker_label="alice", brain_native_vis=False)
    messages = build_talk_messages(
        agent, prep, "talk system", user_message="current", vision_images=None,
        with_micro_plan_prefill=False,
        drop_extra_context=drop_extra,
    )
    assert isinstance(messages[0], SystemMessage)
    assert all(isinstance(message, HumanMessage) for message in messages[1:])
    metadata = [message for message in messages if "[DISCORD CONTEXT]" in message.content]
    assert len(metadata) == (0 if drop_extra else 1)
    assert messages[-1].content == "current"


def discord_message(uid="123", guild=True, resolved=True):
    user = NS(id=uid, name="same", display_name="Same Name")
    bot = NS(id="999", name="Neyra", display_name="Neyra")
    other = NS(id="456", name="other", display_name="Other")
    return NS(id="42", author=user, content="<@999> спроси <@456>", mentions=[bot, other],
              channel=NS(id="77", name="channel" if guild else None, type="text" if guild else "private"),
              guild=NS(id="88", name="Guild") if guild else None,
              reference=NS(message_id="41", channel_id="77", resolved=NS(author=bot) if resolved else None))


@pytest.mark.parametrize("guild,resolved", [(True, True), (True, False), (False, False)])
def test_normalized_context_preserves_source_and_unresolved_reference(guild, resolved):
    message = discord_message(guild=guild, resolved=resolved)
    ctx = context_from_message(message, "999")
    assert ctx.message.content == message.content
    assert ctx.current_user.id == "123"
    assert ctx.response_target.message_id == "42"
    assert bool(ctx.guild) == guild
    assert bool(ctx.message.reference.author) == resolved
    assert [u.id for u in ctx.message.mentions] == ["999", "456"]
    assert ctx.addressed_to_bot


@pytest.mark.parametrize("stream", [False, True])
def test_full_turn_context_identity_model_metadata_and_events(tmp_path, stream):
    agent = offline_agent(tmp_path)
    events = []
    agent.event_bus.subscribe("llm.turn.completed", lambda e: events.append(e.payload))
    context = context_from_message(discord_message(), "999")

    async def run():
        if stream:
            chunks = [c async for c in agent.chat_stream("hello", discord_context=context)]
            assert chunks[-1]["type"] == "done"
            return chunks[-1]
        return await agent.chat("hello", discord_context=context)

    result = asyncio.run(run())
    report = result["model_trace"]
    assert report["status"] == "completed"
    assert {c["lane"] for c in report["calls"]} == {"talk", "brain"}
    assert all(c["reported_model"].startswith("reported-offline") for c in report["calls"])
    for model in (agent.llm_brain, agent.llm_talk):
        messages = model.messages[0]
        assert '[DISCORD CONTEXT]' not in messages[0].content
        assert messages[1].type == "human"
        assert '"id": "123"' in messages[1].content
        assert context.message.content not in messages[1].content
    assert events == [report]
    assert agent.model_activity.for_owner("456", "77") is None
    assert agent.model_activity.for_owner("123", "wrong-channel") is None
    rows = agent.memory_hub.list_chat(user_id=agent.identity.resolve_from_discord("123"), limit=10)
    assert rows
    assert {row["turn_id"] for row in rows} == {report["turn_id"]}
    assert any("model_trace" in str(row) for row in rows)
    agent.memory_hub.close()


def test_parallel_turns_do_not_mix_model_reports(tmp_path):
    agent = offline_agent(tmp_path)
    async def run():
        return await asyncio.gather(*[
            agent.chat(f"hello {uid}", discord_context=context_from_message(discord_message(uid), "999"))
            for uid in ("123", "456")
        ])
    results = asyncio.run(run())
    assert results[0]["model_trace"]["turn_id"] != results[1]["model_trace"]["turn_id"]
    for uid, result in zip(("123", "456"), results):
        assert agent.model_activity.for_owner(uid, "77") == result["model_trace"]
        assert [c["lane"] for c in result["model_trace"]["calls"]][:2] == ["brain", "talk"]
    assert len({row["id"] for row in agent.memory_hub.list_people()}) == 2
    agent.memory_hub.close()


def test_missing_model_and_failure_are_honest(tmp_path):
    agent = offline_agent(tmp_path)
    agent.llm_talk.report_model = False
    out = asyncio.run(agent.chat("hello", discord_user_id="123", channel_id="77"))
    assert out["model_trace"]["calls"][-1]["reported_model"] is None
    agent.llm_brain.failures = 1
    out = asyncio.run(agent.chat("hello", discord_user_id="123", channel_id="77"))
    assert out["model_trace"]["status"] == "failed"
    assert out["model_trace"]["calls"][-1]["status"] == "failed"
    assert "offline provider failure" not in json.dumps(out["model_trace"])
    agent.memory_hub.close()


def test_activity_buffer_is_bounded_and_defensive():
    activity = ModelActivity()
    for i in range(205):
        trace = TurnTrace("private-user", "private-channel")
        activity.append(trace, {"number": i})
    rows = activity.recent(200)
    assert len(rows) == 200
    assert rows[0]["number"] == 204
    rows[0]["number"] = -1
    assert activity.recent(1)[0]["number"] == 204


def test_activity_api_auth_privacy_and_limit(client, app, auth_headers):
    for role in ("viewer", "maint", "admin"):
        r = client.get("/v1/llm/activity", headers=auth_headers[role])
        assert r.status_code == 200
        assert r.json()["data"]["items"] == []
    assert client.get("/v1/llm/activity").status_code == 401
    assert client.get("/v1/llm/activity?limit=201", headers=auth_headers["admin"]).status_code == 422


@pytest.mark.parametrize("native", [False, True])
def test_vision_context_and_real_lane_evidence(tmp_path, native):
    agent = offline_agent(tmp_path)
    agent.config["llm"]["vision_model"].update(enabled=True, use_brain_model_for_vision=native)
    agent.llm_vision = agent.llm_brain if native else OfflineModel("vision")
    if native:
        agent.llm_talk_model = agent.llm_brain_model
    ctx = context_from_message(discord_message(), "999")
    result = asyncio.run(agent.chat("image", discord_context=ctx, vision_images=[("image/png", "AA==")]))
    calls = result["model_trace"]["calls"]
    assert result["model_trace"]["status"] == "completed"
    if native:
        assert not any(c["lane"] == "vision" for c in calls)
        assert any(c["lane"] == "brain" and c["has_images"] for c in calls)
    else:
        assert any(c["lane"] == "vision" and c["has_images"] for c in calls)
        assert '[DISCORD CONTEXT]' not in agent.llm_vision.messages[0][0].content
        assert agent.llm_vision.messages[0][1].type == "human"
        assert '[DISCORD CONTEXT]' in agent.llm_vision.messages[0][1].content
    agent.memory_hub.close()


def test_stream_context_retry_keeps_mode_context_and_attempts(tmp_path):
    agent = offline_agent(tmp_path)
    agent.config["agent"]["conversation_mode"] = "technical"
    agent.llm_talk.errors = [RuntimeError("context_length_exceeded"), RuntimeError("context_length_exceeded")]
    ctx = context_from_message(discord_message(), "999")
    async def run():
        return [c async for c in agent.chat_stream("Explain", discord_context=ctx)]
    chunks = asyncio.run(run())
    assert chunks[-1]["type"] == "done"
    calls = [c for c in chunks[-1]["model_trace"]["calls"] if c["purpose"] == "stream_reply"]
    assert [c["attempt"] for c in calls] == [1, 2, 3]
    assert [c["status"] for c in calls] == ["failed", "failed", "completed"]
    for index, messages in enumerate(agent.llm_talk.messages):
        assert '[DISCORD CONTEXT]' not in messages[0].content
        assert any('[DISCORD CONTEXT]' in str(m.content) for m in messages) == (index < 2)
        assert '[CONVERSATION MODE: technical]' in messages[0].content
    assert ACTIVE_TRACE.get() is None
    agent.memory_hub.close()


def test_cancelled_stream_is_closed_and_recorded(tmp_path):
    agent = offline_agent(tmp_path)
    async def run():
        stream = agent.chat_stream("Hello", discord_user_id="123", channel_id="77")
        first = await anext(stream)
        assert first["type"] == "token"
        assert ACTIVE_TRACE.get() is None
        await asyncio.create_task(stream.aclose())
        assert ACTIVE_TRACE.get() is None
    asyncio.run(run())
    report = agent.model_activity.for_owner("123", "77")
    assert report["status"] == "cancelled"
    assert all(c["status"] != "running" for c in report["calls"])
    agent.memory_hub.close()


def test_fast_path_explicitly_has_no_model(tmp_path):
    agent = offline_agent(tmp_path)
    agent.config["agent"]["fast_path"] = {"enabled": True}
    result = asyncio.run(agent.chat("выключи свет", discord_user_id="123", channel_id="77"))
    assert result["fast_path"]
    assert result["model_trace"]["without_llm"]
    assert result["model_trace"]["calls"] == []
    windows = agent.short_memory.windows()
    assert windows[0]["owner_id"] == agent.identity.resolve_from_discord("123")
    assert windows[0]["channel_id"] == "77"
    agent.memory_hub.close()


def test_rest_ws_context_and_trace_roundtrip(tmp_path):
    from unittest.mock import MagicMock, AsyncMock
    agent = offline_agent(tmp_path)
    monitor = MagicMock(run_once=AsyncMock(return_value={"ok": True}))
    app = build_app(agent.config, shared_agent=agent, shared_monitor=monitor, shared_backup_manager=MagicMock(), project_root=tmp_path)
    ctx = context_from_message(discord_message(), "999").model_dump(mode="json")
    with TestClient(app) as client:
        headers = {"Authorization": "Bearer offline-admin-token"}
        result = client.post("/v1/chat", json={"text": "hello", "discord_context": ctx}, headers=headers)
        assert result.status_code == 200
        assert result.json()["data"]["model_trace"]["calls"]
        with client.websocket_connect("/v1/ws/chat", headers=headers) as ws:
            assert ws.receive_json()["type"] == "hello"
            ws.send_json({"type": "chat", "text": "hello", "discord_context": ctx})
            while True:
                chunk = ws.receive_json()
                if chunk["type"] == "done":
                    assert chunk["model_trace"]["calls"]
                    break
        activity = client.get("/v1/llm/activity", headers=headers).json()["data"]["items"]
        assert len(activity) == 2
        public = json.dumps(activity)
        assert "current_user" not in public
        assert "user_id" not in public
        assert "hello" not in public
        assert client.post("/v1/chat", json={"text": "hello", "discord_context": ctx | {"unexpected": 1}}, headers=headers).status_code == 422
    agent.memory_hub.close()


def test_model_command_is_ephemeral_and_owner_scoped(tmp_path):
    from unittest.mock import AsyncMock
    from modules.discord.bot import NeyraDiscordBot
    agent = offline_agent(tmp_path)
    async def run():
        await agent.chat("hello", discord_user_id="123", channel_id="77")
        bot = NeyraDiscordBot(agent, agent.config)
        bot.tree.sync = AsyncMock(return_value=[])
        await bot.setup_hook()
        command = bot.tree.get_command("model")
        for uid, cid, expected in [("123", "77", "reported-offline-talk"), ("456", "77", "пока нет"), ("123", "78", "пока нет")]:
            interaction = NS(user=NS(id=uid), channel_id=cid, response=NS(send_message=AsyncMock()))
            await command.callback(interaction)
            call = interaction.response.send_message.call_args
            assert call.kwargs["ephemeral"] is True
            assert expected in call.args[0]
        await bot.close()
    asyncio.run(run())
    agent.memory_hub.close()


def test_discord_adapter_keeps_other_mentions_and_passes_context(tmp_path):
    from unittest.mock import AsyncMock
    from modules.discord.bot import NeyraDiscordBot
    agent = offline_agent(tmp_path)
    async def run():
        bot = NeyraDiscordBot(agent, agent.config)
        message = discord_message()
        assert bot.allowed_mentions.to_dict() == {"parse": [], "replied_user": True}
        message.author.bot = False
        message.attachments = []
        bot._connection.user = message.mentions[0]
        bot._collect_image_attachments = AsyncMock(return_value=[])
        bot._classify_intent = AsyncMock(return_value="CHAT")
        bot._run_chat_reply = AsyncMock()
        await bot.on_message(message)
        await asyncio.sleep(0)
        payload = bot._run_chat_reply.call_args.kwargs
        assert "<@456>" in payload["content"]
        assert "<@999>" not in payload["content"]
        assert payload["discord_context"].message.content == message.content
        assert payload["discord_context"].current_user.id == "123"
        await bot.close()
    asyncio.run(run())
    agent.memory_hub.close()


def test_mode_update_only_changes_the_next_turn(tmp_path):
    agent = offline_agent(tmp_path)
    agent.config["agent"]["conversation_mode"] = "brief"
    original = agent.llm_brain.ainvoke
    async def run():
        started, proceed = asyncio.Event(), asyncio.Event()
        async def paused(messages):
            started.set()
            await proceed.wait()
            return await original(messages)
        agent.llm_brain.ainvoke = paused
        task = asyncio.create_task(agent.chat("first"))
        await started.wait()
        agent.config["agent"]["conversation_mode"] = "technical"
        proceed.set()
        first = await task
        agent.llm_brain.ainvoke = original
        second = await agent.chat("second")
        return first, second
    first, second = asyncio.run(run())
    assert "Режим: brief" in first["text"]
    assert "Режим: technical" in second["text"]
    agent.memory_hub.close()
