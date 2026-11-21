"""Per-request model override and WS stop contract."""
from __future__ import annotations

from types import SimpleNamespace as NS

import pytest
from pydantic import ValidationError

from core.agent.llm_setup import talk_model_for
from core.api.app import ChatRequest, WsChatMessage


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

    async def fake_stream(*args, **kwargs):
        yield {"type": "token", "text": "A"}
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
