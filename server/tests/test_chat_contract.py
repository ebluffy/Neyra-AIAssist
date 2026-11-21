"""Per-request model override and WS stop contract."""
from __future__ import annotations

from types import SimpleNamespace as NS

import pytest
from pydantic import ValidationError

from core.agent.llm_setup import talk_model_for
from core.api.app import ChatRequest, WsChatMessage
from test_web_identity_review import real_api  # noqa: F401
from test_web_role import _identity_headers, identity_env  # noqa: F401


class FakeTalk:
    def __init__(self):
        self.kwargs = None

    def bind(self, **kwargs):
        self.kwargs = kwargs
        return self


def test_chat_request_accepts_model_override():
    body = ChatRequest(text="hello", model="openai/gpt-4.1-mini")
    assert body.model == "openai/gpt-4.1-mini"


@pytest.mark.parametrize("bad", ["-leading", "has space", "", "a" * 201])
def test_chat_request_rejects_bad_model(bad):
    with pytest.raises(ValidationError):
        ChatRequest(text="hello", model=bad)


def test_ws_stop_has_no_text_and_is_valid():
    msg = WsChatMessage.model_validate({"type": "stop"})
    assert msg.type == "stop"
    assert msg.text == ""


def test_talk_model_for_binds_requested_model():
    fake = FakeTalk()
    agent = NS(llm_talk=fake, llm_talk_model="default-model")
    out = talk_model_for(agent, "openrouter/anthropic/claude-sonnet")
    assert out is fake
    assert fake.kwargs == {"model": "openrouter/anthropic/claude-sonnet"}


def test_talk_model_for_keeps_default_without_override():
    fake = FakeTalk()
    agent = NS(llm_talk=fake, llm_talk_model="default-model")
    assert talk_model_for(agent, None) is fake
    assert talk_model_for(agent, "default-model") is fake
    assert fake.kwargs is None


def test_ws_stop_cancels_active_stream(tmp_path):
    import asyncio
    from unittest.mock import AsyncMock, MagicMock

    from fastapi.testclient import TestClient

    from core.api import build_app
    from offline_support import offline_agent

    agent = offline_agent(tmp_path)
    calls = 0

    async def fake_stream(*args, **kwargs):
        nonlocal calls
        calls += 1
        yield {"type": "token", "text": "A"}
        if calls == 1:
            await asyncio.sleep(30)
        yield {"type": "done", "text": "A", "sounds": [], "model_trace": None}

    agent.chat_stream = fake_stream
    monitor = MagicMock(run_once=AsyncMock(return_value={"ok": True}))
    app = build_app(
        agent.config,
        shared_agent=agent,
        shared_monitor=monitor,
        shared_backup_manager=MagicMock(),
        project_root=tmp_path,
    )
    try:
        with TestClient(app) as client:
            with client.websocket_connect(
                "/v1/ws/chat", headers={"Authorization": "Bearer offline-admin-token"}
            ) as ws:
                assert ws.receive_json()["type"] == "hello"
                ws.send_json({"type": "chat", "text": "hello"})
                assert ws.receive_json()["type"] == "token"
                ws.send_json({"type": "stop"})
                seen = []
                while "stopped" not in seen:
                    seen.append(ws.receive_json()["type"])
                assert "stopped" in seen
                ws.send_json({"type": "ping"})
                assert ws.receive_json()["type"] == "pong"
                ws.send_json({"type": "chat", "text": "again"})
                assert ws.receive_json()["type"] == "token"
                assert ws.receive_json()["type"] == "done"
    finally:
        agent.memory_hub.close()


def test_rest_chat_passes_model_override(tmp_path):
    from unittest.mock import AsyncMock, MagicMock

    from fastapi.testclient import TestClient

    from core.api import build_app
    from offline_support import offline_agent

    agent = offline_agent(tmp_path)
    agent.chat = AsyncMock(return_value={"text": "ok", "sounds": [], "thoughts": "", "raw": "ok", "model_trace": {}})
    app = build_app(
        agent.config,
        shared_agent=agent,
        shared_monitor=MagicMock(run_once=AsyncMock(return_value={"ok": True})),
        shared_backup_manager=MagicMock(),
        project_root=tmp_path,
    )
    try:
        with TestClient(app) as client:
            response = client.post(
                "/v1/chat",
                json={"text": "hi", "model": "openai/gpt-4.1-mini"},
                headers={"Authorization": "Bearer offline-admin-token"},
            )
        assert response.status_code == 200
        assert agent.chat.await_args.kwargs["model"] == "openai/gpt-4.1-mini"
    finally:
        agent.memory_hub.close()


def test_talk_model_for_clones_chat_openai_model_name():
    from langchain_openai import ChatOpenAI

    base = ChatOpenAI(model="default", api_key="x", base_url="http://127.0.0.1:9")
    out = talk_model_for(NS(llm_talk=base, llm_talk_model="default"), "override-model")
    assert out.model_name == "override-model"


def test_model_allowlist_for_web_role():
    from core.agent.llm_setup import model_allowed_for_role

    config = {
        "llm": {
            "providers": {"p": {"base_url": "http://127.0.0.1:9"}},
            "talk_model": {"provider": "p", "model": "default-model"},
            "chat_models_allowed_for_web": ["allowed-model"],
        }
    }
    assert model_allowed_for_role(config, "web", None) is True
    assert model_allowed_for_role(config, "web", "default-model") is True
    assert model_allowed_for_role(config, "web", "allowed-model") is True
    assert model_allowed_for_role(config, "web", "expensive-model") is False
    assert model_allowed_for_role(config, "admin", "expensive-model") is True


def _ws_app(agent, tmp_path):
    from unittest.mock import AsyncMock, MagicMock

    from core.api import build_app

    return build_app(
        agent.config,
        shared_agent=agent,
        shared_monitor=MagicMock(run_once=AsyncMock(return_value={"ok": True})),
        shared_backup_manager=MagicMock(),
        project_root=tmp_path,
    )


def test_ws_busy_does_not_cancel_active_stream(tmp_path):
    import asyncio

    from fastapi.testclient import TestClient

    from offline_support import offline_agent

    agent = offline_agent(tmp_path)

    async def fake_stream(*args, **kwargs):
        yield {"type": "token", "text": "A"}
        await asyncio.sleep(0.3)
        yield {"type": "done", "text": "A", "sounds": [], "model_trace": None}

    agent.chat_stream = fake_stream
    try:
        with TestClient(_ws_app(agent, tmp_path)) as client:
            with client.websocket_connect(
                "/v1/ws/chat", headers={"Authorization": "Bearer offline-admin-token"}
            ) as ws:
                assert ws.receive_json()["type"] == "hello"
                ws.send_json({"type": "chat", "text": "hello"})
                assert ws.receive_json()["type"] == "token"
                ws.send_json({"type": "chat", "text": "second"})
                busy = ws.receive_json()
                assert busy["type"] == "error"
                assert busy["code"] == "busy"
                assert ws.receive_json()["type"] == "done"
    finally:
        agent.memory_hub.close()


def test_ws_ping_while_streaming_gets_pong(tmp_path):
    import asyncio

    from fastapi.testclient import TestClient

    from offline_support import offline_agent

    agent = offline_agent(tmp_path)

    async def fake_stream(*args, **kwargs):
        yield {"type": "token", "text": "A"}
        await asyncio.sleep(0.3)
        yield {"type": "done", "text": "A", "sounds": [], "model_trace": None}

    agent.chat_stream = fake_stream
    try:
        with TestClient(_ws_app(agent, tmp_path)) as client:
            with client.websocket_connect(
                "/v1/ws/chat", headers={"Authorization": "Bearer offline-admin-token"}
            ) as ws:
                assert ws.receive_json()["type"] == "hello"
                ws.send_json({"type": "chat", "text": "hello"})
                assert ws.receive_json()["type"] == "token"
                ws.send_json({"type": "ping"})
                assert ws.receive_json()["type"] == "pong"
                assert ws.receive_json()["type"] == "done"
    finally:
        agent.memory_hub.close()


def test_ws_malformed_frame_does_not_cancel_active_stream(tmp_path):
    import asyncio

    from fastapi.testclient import TestClient

    from offline_support import offline_agent

    agent = offline_agent(tmp_path)

    async def fake_stream(*args, **kwargs):
        yield {"type": "token", "text": "A"}
        await asyncio.sleep(0.3)
        yield {"type": "done", "text": "A", "sounds": [], "model_trace": None}

    agent.chat_stream = fake_stream
    try:
        with TestClient(_ws_app(agent, tmp_path)) as client:
            with client.websocket_connect(
                "/v1/ws/chat", headers={"Authorization": "Bearer offline-admin-token"}
            ) as ws:
                assert ws.receive_json()["type"] == "hello"
                ws.send_json({"type": "chat", "text": "hello"})
                assert ws.receive_json()["type"] == "token"
                ws.send_text("{not-json")
                error = ws.receive_json()
                assert error["type"] == "error"
                assert error["code"] == "bad_payload"
                assert ws.receive_json()["type"] == "done"
    finally:
        agent.memory_hub.close()


def test_talk_model_for_clones_cli_without_mutating_source():
    from core.llm.cli_provider import CliChatModel, CliSettings

    settings = CliSettings(
        cli="opencode",
        backend="run",
        model="default-model",
        sandbox="/tmp/sandbox",
        cli_path="/usr/bin/opencode",
    )
    base = CliChatModel(settings=settings, provider_name="oc")
    out = talk_model_for(NS(llm_talk=base, llm_talk_model="default-model"), "override-model")
    assert out is not base
    assert out.settings.model == "override-model"
    assert base.settings.model == "default-model"


def test_responses_talk_uses_bound_model_name():
    from core.agent.responses_talk import ResponsesTalk

    model = NS(model_name="clone-model")
    tx = NS(connection=object())
    agent = NS(config={}, llm_talk_model="default-model")
    talk = ResponsesTalk(agent, model, tx)
    assert talk.model_name == "clone-model"


def test_web_role_cannot_select_unlisted_model(real_api):
    http, agent = real_api
    async def fake_stream(*args, **kwargs):
        yield {"type": "done", "text": "must-not-run", "sounds": [], "model_trace": None}
    agent.chat_stream = fake_stream
    with http.websocket_connect("/v1/ws/chat", headers=_identity_headers()) as ws:
        assert ws.receive_json()["type"] == "hello"
        ws.send_json({"type": "chat", "text": "hi", "model": "expensive-model"})
        event = ws.receive_json()
        assert event["type"] == "error"
        assert event["code"] == "model_not_allowed"


def test_plan_talk_vision_uses_caption_for_model_override():
    from core.agent.turn_prep import plan_talk_vision

    plan = plan_talk_vision(
        [("image/png", "base64")],
        brain_native_vis=False,
        talk_model="override-model",
        brain_model="brain-model",
        has_vision_llm=True,
        talk_is_vision_client=False,
        vision_is_brain_client=False,
    )
    assert plan.need_talk_caption is True
    assert plan.talk_vm is None


def test_ws_race_both_done_keeps_client_frame(tmp_path):
    from fastapi.testclient import TestClient

    from offline_support import offline_agent

    agent = offline_agent(tmp_path)
    seen = []

    async def fake_stream(*args, **kwargs):
        seen.append(kwargs.get("text") if "text" in kwargs else (args[0] if args else ""))
        yield {"type": "done", "text": "ok", "sounds": [], "model_trace": None}

    agent.chat_stream = fake_stream
    try:
        with TestClient(_ws_app(agent, tmp_path)) as client:
            with client.websocket_connect(
                "/v1/ws/chat", headers={"Authorization": "Bearer offline-admin-token"}
            ) as ws:
                assert ws.receive_json()["type"] == "hello"
                ws.send_json({"type": "chat", "text": "first"})
                ws.send_json({"type": "chat", "text": "second"})
                first = ws.receive_json()
                second = ws.receive_json()
                assert first["type"] == "done"
                assert second["type"] == "done"
                assert len(seen) == 2
    finally:
        agent.memory_hub.close()


def test_prepare_turn_override_uses_vision_caption(tmp_path):
    import asyncio
    from unittest.mock import AsyncMock

    from core.agent.turn_prep import prepare_turn
    from offline_support import offline_agent

    agent = offline_agent(tmp_path)
    agent.llm_vision = object()
    agent._caption_vision_images = AsyncMock(return_value="caption")
    try:
        prep = asyncio.run(
            prepare_turn(
                agent,
                user_message="что на картинке?",
                username="u1",
                discord_user_id=None,
                vision_images=[("image/png", "x")],
                channel_id="c1",
                author_display_name="U",
                lyrics_marker="",
                model="override-model",
            )
        )
        assert prep.talk_vm is None
        assert prep.attached_caption == "caption"
        agent._caption_vision_images.assert_awaited_once()
    finally:
        agent.memory_hub.close()
