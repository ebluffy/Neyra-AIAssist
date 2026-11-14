"""Web role in #73: attachments/context/me need identity; admin routes are denied."""

from __future__ import annotations

import pytest
from starlette.websockets import WebSocketDisconnect

from test_web_identity import identity_env, token  # noqa: F401
from test_web_identity_review import real_api  # noqa: F401

WEB = {"Authorization": "Bearer web-secret-token-xxxxxxxxxx"}


def headers():
    return {**WEB, "X-Neyra-Identity": token()}


def upload(http):
    return http.post(
        "/v1/attachments",
        headers=headers(),
        data={"channel_id": "c1"},
        files=[("files", ("note.txt", b"hello", "text/plain"))],
    )


def test_web_identity_is_required_for_attachments(real_api):
    http, _agent = real_api
    assert upload(http).status_code == 200
    assert http.post(
        "/v1/attachments",
        headers=WEB,
        data={"channel_id": "c1"},
        files=[("files", ("note.txt", b"hello", "text/plain"))],
    ).status_code == 403


def test_web_key_can_read_context_limits_and_me(real_api):
    http, _agent = real_api
    assert http.get("/v1/context/limits?channel_id=c1", headers=headers()).status_code == 200
    me = http.get("/v1/web/me", headers=headers())
    assert me.status_code == 200 and me.json()["data"]["user_id"] == "web-user-1"


def test_web_key_cannot_use_admin_or_maint_routes(real_api):
    http, _agent = real_api
    assert http.post("/v1/backup/run", headers=WEB).status_code == 403
    assert http.get("/v1/llm/activity", headers=WEB).status_code == 403


def _identity(sub="web-user-1"):
    from test_web_identity import claims, token
    return {**WEB, "X-Neyra-Identity": token(claims(sub=sub))}


def test_web_key_can_use_scoped_memory_routes(real_api):
    http, _agent = real_api
    search = http.post(
        "/v1/memory/search", headers=_identity(),
        json={"query": "hello", "user_id": "someone-else", "top_k": 3},
    )
    assert search.status_code == 200, search.text
    from core.runtime.identity import UnifiedIdentityMapper

    person_id = UnifiedIdentityMapper.resolve("web", "web-user-1")
    assert search.json()["data"]["user_id"] == person_id

    hub = _agent.memory_hub
    hub.append_chat(role="user", text="foreign-row", user_id="foreign-person", channel_id="c1")
    hub.append_chat(role="user", text="own-row", user_id=person_id, channel_id="c1")
    recall = http.post(
        "/v1/memory/chat/recall", headers=_identity(),
        json={"user_id": "someone-else", "channel_id": "c1"},
    )
    assert recall.status_code == 200, recall.text
    texts = [row.get("text") for row in recall.json()["data"]["messages"]]
    assert "own-row" in texts
    assert "foreign-row" not in texts

    own = http.get(f"/v1/memory/people/{person_id}", headers=_identity())
    assert own.status_code == 200
    other = http.get("/v1/memory/people/not-my-person", headers=_identity())
    assert other.status_code == 403


def test_web_key_with_identity_still_denied_admin_and_maint(real_api):
    http, _agent = real_api
    assert http.post("/v1/backup/run", headers=_identity()).status_code == 403
    assert http.post("/v1/system/restart", headers=_identity()).status_code == 403


def test_web_key_can_open_ws_chat(real_api, monkeypatch):
    http, agent = real_api

    def fake_stream(*args, **kwargs):
        async def stream():
            yield {"type": "token", "text": "ok"}
            yield {"type": "done", "text": "ok", "sounds": []}
        return stream()

    monkeypatch.setattr(agent, "chat_stream", fake_stream)
    with http.websocket_connect("/v1/ws/chat", headers=_identity()) as socket:
        hello = socket.receive_json()
        assert hello["type"] == "hello" and hello["role"] == "web"
        socket.send_json({"type": "chat", "text": "hi", "channel_id": "web"})
        final = None
        while True:
            event = socket.receive_json()
            if event["type"] in {"done", "error"}:
                final = event
                break
    assert final["type"] == "done"


def test_web_key_denied_routes_return_forbidden_code(real_api):
    http, _agent = real_api
    response = http.post("/v1/backup/run", headers=_identity())
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "forbidden"


def test_web_key_cannot_modify_people(real_api):
    http, _agent = real_api
    from core.runtime.identity import UnifiedIdentityMapper

    person_id = UnifiedIdentityMapper.resolve("web", "web-user-1")
    patch = http.patch(f"/v1/memory/people/{person_id}", headers=_identity(), json={})
    delete = http.delete(f"/v1/memory/people/{person_id}", headers=_identity())
    assert patch.status_code == 403 and patch.json()["error"]["code"] == "web_memory_forbidden"
    assert delete.status_code == 403 and delete.json()["error"]["code"] == "web_memory_forbidden"

    from test_web_identity import claims, token
    admin = {**WEB, "X-Neyra-Identity": token(claims(role="admin"))}
    admin_patch = http.patch(f"/v1/memory/people/{person_id}", headers=admin, json={})
    assert admin_patch.status_code == 403 and admin_patch.json()["error"]["code"] == "forbidden"


def test_web_ws_without_identity_is_closed(real_api):
    http, _agent = real_api
    with pytest.raises(WebSocketDisconnect) as error:
        with http.websocket_connect("/v1/ws/chat", headers=WEB) as socket:
            socket.receive_json()
    assert error.value.code == 1008


def test_web_foreign_attachment_is_not_found(real_api):
    http, _agent = real_api
    ref = upload(http).json()["data"]["attachments"][0]
    with http.websocket_connect("/v1/ws/chat", headers=_identity(sub="other-user")) as socket:
        assert socket.receive_json()["type"] == "hello"
        socket.send_json({"type": "chat", "text": "steal", "channel_id": "c1", "attachments": [ref]})
        while True:
            event = socket.receive_json()
            if event["type"] in {"error", "done"}:
                break
    assert event["type"] == "error"
    assert event["code"] == "attachment_not_found"
