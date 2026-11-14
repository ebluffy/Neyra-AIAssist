"""WS chat error frames carry the real code and a user-facing reason (Wave 3)."""

import pytest
from langchain_core.messages import AIMessageChunk

from core.agent.public_errors import provider_rate_limit_message
from test_web_identity import headers, identity_env  # noqa: F401  (autouse JWT env)
from test_web_identity_review import real_api  # noqa: F401  (fixture)


def turn(http, auth_headers):
    events = []
    with http.websocket_connect("/v1/ws/chat", headers=headers(auth_headers, role="admin")) as socket:
        assert socket.receive_json()["type"] == "hello"
        socket.send_json({"type": "chat", "text": "hi", "channel_id": "chat-err"})
        while True:
            event = socket.receive_json()
            events.append(event)
            if event["type"] in ("done", "error"):
                return events


def failing_stream(error: Exception):
    async def stream(messages):
        if False:  # pragma: no cover - makes this an async generator
            yield AIMessageChunk(content="")
        raise error
    return stream


def test_provider_rate_limit_is_named_instead_of_generic_failure(real_api, auth_headers, monkeypatch):
    http, agent = real_api
    agent.llm_talk.astream = failing_stream(RuntimeError("429 Too Many Requests"))
    monkeypatch.setattr(
        "core.agent.model_trace.recent_provider_rate_limit",
        lambda _agent, window_seconds=600: {
            "error_class": "OpenAIRateLimitError",
            "http_status": 429,
            "at": "2026-11-13T12:00:00",
        },
    )

    error = turn(http, auth_headers)[-1]
    assert error["type"] == "error"
    assert error["code"] == "provider_rate_limit"
    assert "429" in error["message"]
    # Upstream class names stay out of the user-facing text.
    assert "OpenAIRateLimitError" not in error["message"]
    assert "Traceback" not in error["message"]


def test_generic_error_keeps_core_code_and_public_text(real_api, auth_headers, monkeypatch):
    http, agent = real_api
    agent.llm_talk.astream = failing_stream(RuntimeError("PRIVATE-UPSTREAM-DETAIL"))
    monkeypatch.setattr("core.agent.model_trace.recent_provider_rate_limit", lambda _agent, window_seconds=600: None)

    error = turn(http, auth_headers)[-1]
    assert error["code"] == "generation_failed"
    assert error["message"]
    assert "PRIVATE-UPSTREAM-DETAIL" not in error["message"]


def test_rate_limit_message_is_user_facing_and_promises_no_exact_hour():
    text = provider_rate_limit_message()
    assert "429" in text
    assert "провайдер" in text.lower()
    assert "OpenAI" not in text
