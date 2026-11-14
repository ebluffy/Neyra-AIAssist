"""Web role in #73: attachments/context/me need identity; admin routes are denied."""

from __future__ import annotations

import pytest

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
