from test_web_identity import headers, identity_env  # noqa: F401
from test_web_identity_review import real_api  # noqa: F401


def test_v1_chat_platform_id_keeps_discord_owner_and_empty_label(
    client, stub_agent, auth_headers
):
    response = client.post(
        "/v1/chat",
        headers=auth_headers["admin"],
        json={"text": "hi", "platform_user_id": "123"},
    )
    assert response.status_code == 200, response.text
    kwargs = stub_agent.chat.await_args.kwargs
    assert kwargs["username"] == ""
    assert kwargs["discord_user_id"] == "123"
    assert kwargs["speaker_name"] is None


def test_v1_chat_without_identity_keeps_placeholder_owner_only(
    client, stub_agent, auth_headers
):
    response = client.post(
        "/v1/chat", headers=auth_headers["admin"], json={"text": "hi"}
    )
    assert response.status_code == 200, response.text
    kwargs = stub_agent.chat.await_args.kwargs
    assert kwargs["username"] == "api_user"
    assert kwargs["speaker_name"] == ""


def test_ws_blank_username_keeps_ws_user_owner(real_api, auth_headers, monkeypatch):
    http, agent = real_api
    seen = {}

    async def fake_stream(*args, **kwargs):
        seen.update(kwargs)
        yield {"type": "done", "text": "ok"}

    monkeypatch.setattr(agent, "chat_stream", fake_stream)
    with http.websocket_connect(
        "/v1/ws/chat", headers=auth_headers["admin"]
    ) as socket:
        assert socket.receive_json()["type"] == "hello"
        socket.send_json(
            {"type": "chat", "text": "hi", "username": "   ", "channel_id": "ws"}
        )
        while True:
            event = socket.receive_json()
            if event["type"] in ("done", "error"):
                break
    assert seen["username"] == "ws_user"
    assert seen["speaker_name"] == ""
