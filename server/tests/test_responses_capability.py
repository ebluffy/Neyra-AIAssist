"""Provider capability opt-out for /v1/responses (AR-55 part 2)."""
from __future__ import annotations

from types import SimpleNamespace as NS

from core.agent.talk_sessions import TalkSessions, responses_supported, responses_talk_model


def _agent(supported: bool):
    return NS(
        _llm_conn_talk=NS(provider="gateway", capabilities={"supports_responses": supported}),
        config={"llm": {"talk_model": {"responses": {"enabled": True, "warmup_on_start": True}}}},
        llm_talk_model="default-model",
        talk_sessions=None,
    )


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
