"""Web chat history and per-user notes over the real ASGI routes (offline)."""

import pytest

from core.memory.sqlite_store import SqliteStore
from test_web_identity import claims, headers, identity_env, token  # noqa: F401
from test_web_identity_review import real_api  # noqa: F401  (fixture)


def user_headers(auth_headers, sub: str = "web-user-1"):
    return headers(auth_headers, signed=token(claims(sub=sub)), role="admin")


def make_thread(http, auth_headers, title: str = "Тред") -> dict:
    response = http.post("/v1/threads", headers=user_headers(auth_headers), json={"title": title})
    assert response.status_code == 200, response.text
    return response.json()["data"]


def add_message(http, auth_headers, thread_id: str, content: str, **extra):
    return http.post(
        f"/v1/threads/{thread_id}/messages",
        headers=user_headers(auth_headers),
        json={"content": content, **extra},
    )


def test_threads_require_web_identity(real_api, auth_headers):
    http, _agent = real_api
    assert http.get("/v1/threads").status_code == 401
    assert http.get("/v1/threads", headers=auth_headers["admin"]).status_code == 401
    assert http.post("/v1/threads", headers=auth_headers["admin"], json={}).status_code == 401
    assert http.get("/v1/notes").status_code == 401


def test_thread_crud_and_soft_delete(real_api, auth_headers):
    http, _agent = real_api
    thread = make_thread(http, auth_headers, "Первый")
    thread_id = thread["id"]
    assert thread["message_count"] == 0 and thread["title"] == "Первый"

    listing = http.get("/v1/threads", headers=user_headers(auth_headers))
    assert listing.status_code == 200
    assert [item["id"] for item in listing.json()["data"]["items"]] == [thread_id]

    assert add_message(http, auth_headers, thread_id, "привет").status_code == 200
    assert add_message(http, auth_headers, thread_id, "как дела").status_code == 200

    detail = http.get(f"/v1/threads/{thread_id}", headers=user_headers(auth_headers))
    assert detail.status_code == 200
    data = detail.json()["data"]
    assert [m["content"] for m in data["messages"]] == ["привет", "как дела"]
    assert [m["seq"] for m in data["messages"]] == [1, 2]
    assert data["thread"]["message_count"] == 2
    assert data["thread"]["last_message_at"]

    patched = http.patch(
        f"/v1/threads/{thread_id}", headers=user_headers(auth_headers), json={"title": "Новый", "archived": True}
    )
    assert patched.status_code == 200
    assert patched.json()["data"]["title"] == "Новый"
    assert patched.json()["data"]["archived"] is True

    removed = http.delete(f"/v1/threads/{thread_id}", headers=user_headers(auth_headers))
    assert removed.status_code == 200
    assert http.get(f"/v1/threads/{thread_id}", headers=user_headers(auth_headers)).status_code == 404
    assert http.get("/v1/threads", headers=user_headers(auth_headers)).json()["data"]["items"] == []
    assert http.delete(f"/v1/threads/{thread_id}", headers=user_headers(auth_headers)).status_code == 404


def test_message_delete_and_idempotent_client_id(real_api, auth_headers):
    http, _agent = real_api
    thread_id = make_thread(http, auth_headers)["id"]

    first = add_message(http, auth_headers, thread_id, "один", client_message_id="client-msg-1")
    assert first.status_code == 200
    again = add_message(http, auth_headers, thread_id, "один", client_message_id="client-msg-1")
    assert again.status_code == 200
    assert again.json()["data"]["id"] == first.json()["data"]["id"]
    assert again.json()["data"]["seq"] == first.json()["data"]["seq"]

    detail = http.get(f"/v1/threads/{thread_id}", headers=user_headers(auth_headers)).json()["data"]
    assert len(detail["messages"]) == 1

    message_id = first.json()["data"]["id"]
    assert http.delete(
        f"/v1/threads/{thread_id}/messages/{message_id}", headers=user_headers(auth_headers)
    ).status_code == 200
    assert http.get(f"/v1/threads/{thread_id}", headers=user_headers(auth_headers)).json()["data"]["messages"] == []
    assert http.delete(
        f"/v1/threads/{thread_id}/messages/{message_id}", headers=user_headers(auth_headers)
    ).status_code == 404


def test_thread_and_note_isolation_between_users(real_api, auth_headers):
    http, _agent = real_api
    owner = user_headers(auth_headers, "owner-user")
    stranger = user_headers(auth_headers, "stranger-user")

    thread = http.post("/v1/threads", headers=owner, json={"title": "Чужой"}).json()["data"]
    thread_id = thread["id"]
    http.post(f"/v1/threads/{thread_id}/messages", headers=owner, json={"content": "секрет"})
    note = http.post("/v1/notes", headers=owner, json={"text": "личная заметка", "thread_id": thread_id}).json()["data"]

    assert http.get("/v1/threads", headers=stranger).json()["data"]["items"] == []
    assert http.get(f"/v1/threads/{thread_id}", headers=stranger).status_code == 404
    assert http.patch(f"/v1/threads/{thread_id}", headers=stranger, json={"title": "x"}).status_code == 404
    assert http.delete(f"/v1/threads/{thread_id}", headers=stranger).status_code == 404
    assert http.post(
        f"/v1/threads/{thread_id}/messages", headers=stranger, json={"content": "вторжение"}
    ).status_code == 404

    assert http.get("/v1/notes", headers=stranger).json()["data"]["items"] == []
    assert http.get(f"/v1/notes?thread_id={thread_id}", headers=stranger).json()["data"]["items"] == []
    assert http.patch(f"/v1/notes/{note['id']}", headers=stranger, json={"text": "x"}).status_code == 404
    assert http.delete(f"/v1/notes/{note['id']}", headers=stranger).status_code == 404

    # Владелец всё ещё видит свои записи.
    assert http.get(f"/v1/threads/{thread_id}", headers=owner).status_code == 200
    assert len(http.get("/v1/notes", headers=owner).json()["data"]["items"]) == 1


def test_notes_crud_and_pinned_order(real_api, auth_headers):
    http, _agent = real_api
    heads = user_headers(auth_headers)
    first = http.post("/v1/notes", headers=heads, json={"text": "обычная"}).json()["data"]
    pinned = http.post("/v1/notes", headers=heads, json={"text": "важная", "pinned": True}).json()["data"]

    listing = http.get("/v1/notes", headers=heads).json()["data"]["items"]
    assert [item["id"] for item in listing] == [pinned["id"], first["id"]]

    patched = http.patch(f"/v1/notes/{first['id']}", headers=heads, json={"text": "обновлена", "pinned": True})
    assert patched.status_code == 200
    assert patched.json()["data"]["text"] == "обновлена"
    assert patched.json()["data"]["pinned"] is True

    assert http.patch(f"/v1/notes/{first['id']}", headers=heads, json={"text": "  "}).status_code == 400
    assert http.delete(f"/v1/notes/{first['id']}", headers=heads).status_code == 200
    assert [item["id"] for item in http.get("/v1/notes", headers=heads).json()["data"]["items"]] == [pinned["id"]]


def test_pagination_threads_and_messages(real_api, auth_headers):
    http, _agent = real_api
    heads = user_headers(auth_headers)
    ids = []
    for index in range(3):
        ids.append(http.post("/v1/threads", headers=heads, json={"title": f"T{index}"}).json()["data"]["id"])

    page1 = http.get("/v1/threads?limit=2", headers=heads).json()["data"]
    assert len(page1["items"]) == 2 and page1["next_cursor"]
    page2 = http.get(f"/v1/threads?limit=2&cursor={page1['next_cursor']}", headers=heads).json()["data"]
    assert len(page2["items"]) == 1
    assert {i["id"] for i in page1["items"]} & {i["id"] for i in page2["items"]} == set()

    thread_id = ids[0]
    for index in range(5):
        assert add_message(http, auth_headers, thread_id, f"m{index}").status_code == 200

    latest = http.get(f"/v1/threads/{thread_id}?limit=2", headers=heads).json()["data"]
    assert [m["content"] for m in latest["messages"]] == ["m3", "m4"]
    assert latest["has_more"] is True
    older = http.get(
        f"/v1/threads/{thread_id}?limit=2&before={latest['next_before']}", headers=heads
    ).json()["data"]
    assert [m["content"] for m in older["messages"]] == ["m1", "m2"]

    assert http.get("/v1/threads?limit=101", headers=heads).status_code == 422
    assert http.get(f"/v1/threads/{thread_id}?limit=0", headers=heads).status_code == 422


def test_user_id_in_body_is_rejected(real_api, auth_headers):
    http, _agent = real_api
    response = http.post("/v1/notes", headers=user_headers(auth_headers), json={"text": "x", "user_id": "other"})
    assert response.status_code == 422


def test_rest_chat_saves_user_and_assistant_messages(real_api, auth_headers):
    http, _agent = real_api
    heads = user_headers(auth_headers)
    thread_id = http.post("/v1/threads", headers=heads, json={"title": "Чат"}).json()["data"]["id"]

    response = http.post("/v1/chat", headers=heads, json={"text": "привет", "thread_id": thread_id})
    assert response.status_code == 200, response.text

    data = http.get(f"/v1/threads/{thread_id}", headers=heads).json()["data"]
    assert [m["role"] for m in data["messages"]] == ["user", "assistant"]
    assert data["messages"][0]["content"] == "привет"
    assert data["messages"][1]["content"]

    foreign = http.post(
        "/v1/chat", headers=user_headers(auth_headers, "stranger"), json={"text": "x", "thread_id": thread_id}
    )
    assert foreign.status_code == 404


def test_ws_chat_saves_user_and_assistant_messages(real_api, auth_headers):
    http, _agent = real_api
    heads = user_headers(auth_headers)
    thread_id = http.post("/v1/threads", headers=heads, json={"title": "WS"}).json()["data"]["id"]

    with http.websocket_connect("/v1/ws/chat", headers=heads) as socket:
        assert socket.receive_json()["type"] == "hello"
        socket.send_json({"type": "chat", "text": "через ws", "channel_id": "web-chat", "thread_id": thread_id})
        while True:
            event = socket.receive_json()
            if event["type"] in ("done", "error"):
                break
    assert event["type"] == "done", event

    data = http.get(f"/v1/threads/{thread_id}", headers=heads).json()["data"]
    assert [m["role"] for m in data["messages"]] == ["user", "assistant"]
    assert data["messages"][0]["content"] == "через ws"


def test_migration_is_idempotent_and_preserves_existing_data(tmp_path):
    db = tmp_path / "hub.db"
    store = SqliteStore(db)
    try:
        versions = [int(r[0]) for r in store._conn.execute("SELECT version FROM schema_migrations ORDER BY version")]
        assert versions == list(range(1, 10))
        tables = {r[0] for r in store._conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"web_threads", "web_thread_messages", "web_notes"} <= tables
        store.append_chat_rows([{"role": "user", "text": "old", "ts": "2026-11-01T00:00:00+00:00"}])
        store.migrate()  # повторный прогон не должен падать или дублировать версии
        assert [int(r[0]) for r in store._conn.execute("SELECT version FROM schema_migrations ORDER BY version")] == list(range(1, 10))
        assert store._conn.execute("SELECT COUNT(*) FROM chat_log").fetchone()[0] == 1
    finally:
        store.close()
