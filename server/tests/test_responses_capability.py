"""Provider capability opt-out for /v1/responses (AR-55 part 2)."""
from __future__ import annotations

import logging
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi.testclient import TestClient

from core.agent import talk_sessions
from core.agent.talk_sessions import TalkSessions, responses_supported, responses_talk_model
from core.api.app import build_app
from core.llm.profile import OpenAICompatibleConnection, resolve_openai_compatible_connection
from offline_support import offline_agent


@pytest.fixture(autouse=True)
def _fresh_warnings(monkeypatch):
    monkeypatch.setattr(talk_sessions, "_RESPONSES_WARNED", set())


def _agent(supported: bool):
    return NS(
        _llm_conn_talk=NS(provider="gateway", capabilities={"supports_responses": supported}),
        config={"llm": {"talk_model": {"responses": {"enabled": True, "warmup_on_start": True}}}},
        llm_talk_model="default-model",
        talk_sessions=None,
    )


def _config(raw_capability):
    return {
        "llm": {
            "talk_model": {"provider": "gateway", "model": "gateway-model"},
            "providers": {
                "gateway": {
                    "base_url": "https://gateway.invalid/v1",
                    "api_key": "synthetic-secret",
                    "capabilities": {"supports_responses": raw_capability},
                }
            },
        }
    }


def test_unsupported_responses_falls_back_to_plain_model():
    agent = _agent(False)
    model = object()
    assert responses_supported(agent) is False
    assert responses_talk_model(agent, model) is model
    manager = TalkSessions(agent)
    assert manager.start_warmup(manual=True) is False
    status = manager.status()
    assert status["configured"] is True
    assert status["supported"] is False
    assert status["enabled"] is False
    assert status["warmup_state"] == "unsupported"


def test_default_capability_keeps_responses_enabled():
    agent = _agent(True)
    assert responses_supported(agent) is True
    manager = TalkSessions(agent)
    assert manager.status()["enabled"] is True


def test_config_capability_reaches_connection():
    conn = resolve_openai_compatible_connection(_config(False), role="talk_model")
    assert conn.capabilities["supports_responses"] is False


@pytest.mark.parametrize(
    ("raw", "expected"),
    [(False, False), (0, False), ("false", False), (" NO ", False),
     (True, True), (1, True), ("yes", True), ("ON", True)],
)
def test_capability_accepts_strict_bool_spellings(raw, expected):
    conn = resolve_openai_compatible_connection(_config(raw), role="talk_model")
    assert conn.capabilities["supports_responses"] is expected


def test_invalid_capability_keeps_default_and_warns(caplog):
    with caplog.at_level(logging.WARNING, logger="neyra.llm_profile"):
        conn = resolve_openai_compatible_connection(_config("maybe"), role="talk_model")
    assert conn.capabilities["supports_responses"] is True
    assert any("supports_responses" in record.getMessage() for record in caplog.records)


def test_unsupported_warns_once(caplog):
    agent = _agent(False)
    with caplog.at_level(logging.WARNING, logger="neyra.talk_sessions"):
        assert responses_supported(agent) is False
        assert responses_supported(agent) is False
    warnings = [r for r in caplog.records if "supports_responses" in r.getMessage()]
    assert len(warnings) == 1


def test_unsupported_flag_wins_over_active_transaction(monkeypatch):
    agent = _agent(False)
    monkeypatch.setattr(talk_sessions, "current_transaction", lambda: object())
    model = object()
    assert responses_talk_model(agent, model) is model


def test_warmup_rejects_unsupported_provider(tmp_path):
    agent = offline_agent(tmp_path)
    agent.config["llm"]["talk_model"]["responses"] = {"enabled": True, "warmup_on_start": False}
    agent._llm_conn_talk = OpenAICompatibleConnection(
        "offline",
        "http://127.0.0.1:1/v1",
        "synthetic-secret",
        capabilities={"supports_responses": False},
    )
    app = build_app(
        agent.config,
        shared_agent=agent,
        shared_monitor=MagicMock(run_once=AsyncMock()),
        shared_backup_manager=MagicMock(),
        project_root=tmp_path,
    )
    admin = {"Authorization": "Bearer offline-admin-token"}
    viewer = {"Authorization": "Bearer offline-viewer-token"}
    try:
        with TestClient(app) as client:
            response = client.post("/v1/llm/sessions/warmup", headers=admin)
            assert response.status_code == 409
            assert response.json()["error"]["code"] == "responses_unsupported"
            status = client.get("/v1/llm/sessions", headers=viewer).json()["data"]
            assert status["configured"] is True
            assert status["supported"] is False
            assert status["warmup_state"] == "unsupported"
    finally:
        agent.memory_hub.close()
