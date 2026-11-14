"""Web role: separate site key for chat/attachments/me, no admin routes (AR-23)."""

from __future__ import annotations

import pytest
from starlette.websockets import WebSocketDisconnect

from test_web_identity import identity_env, token  # noqa: F401
from test_web_identity_review import real_api  # noqa: F401

WEB = {"Authorization": "Bearer web-secret-token-xxxxxxxxxx"}


def _identity_headers():
    return {**WEB, "X-Neyra-Identity": token()}


def _fake_chat_stream(*args, **kwargs):
    async def stream():
        yield {"type": "token", "text": "ok"}
        yield {"type": "done", "text": "ok", "sounds": []}

    return stream()


def test_web_key_can_open_ws_chat_and_get_done(real_api, monkeypatch):
    http, agent = real_api
    monkeypatch.setattr(agent, "chat_stream", _fake_chat_stream)

    with http.websocket_connect("/v1/ws/chat", headers=_identity_headers()) as socket:
        hello = socket.receive_json()
        assert hello["type"] == "hello" and hello["role"] == "web"
        socket.send_json({"type": "chat", "text": "hi", "channel_id": "web-chat"})
        events = []
        while True:
            event = socket.receive_json()
            events.append(event)
            if event["type"] in {"done", "error"}:
                break
    assert events[-1]["type"] == "done"
    assert events[-1]["text"] == "ok"


def test_web_key_ws_without_identity_is_denied(real_api):
    http, _agent = real_api
    with pytest.raises(WebSocketDisconnect):
        with http.websocket_connect("/v1/ws/chat", headers=WEB) as socket:
            socket.receive_json()


def test_web_key_cannot_call_admin_routes(real_api):
    http, _agent = real_api
    assert http.get("/v1/config", headers=WEB).status_code == 403
    assert http.get("/v1/admin/discord/guilds", headers=WEB).status_code == 403
    assert http.get("/v1/logs/tail", headers=WEB).status_code == 403


def test_web_key_reads_web_me_only_with_identity(real_api):
    http, _agent = real_api
    assert http.get("/v1/web/me", headers=WEB).status_code == 401
    response = http.get("/v1/web/me", headers=_identity_headers())
    assert response.status_code == 200
    assert response.json()["data"]["user_id"] == "web-user-1"


def test_api_web_token_env_maps_to_config(monkeypatch):
    from core.runtime.secrets import apply_env_secrets

    monkeypatch.setenv("API_WEB_TOKEN", "web-env-token-0123456789")
    cfg: dict = {}
    apply_env_secrets(cfg)
    assert cfg["api"]["web_token"] == "web-env-token-0123456789"
