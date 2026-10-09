"""T0/B1: error envelope, trace_id validation, no exception leak in 5xx."""

from __future__ import annotations

import pytest


def test_error_envelope_has_trace_id(client, auth_headers):
    r = client.get("/v1/health")
    assert r.status_code == 401
    body = r.json()
    assert body.get("ok") is False
    assert "error" in body and body["error"].get("code")
    assert body.get("trace_id")
    assert r.headers.get("x-trace-id") == body["trace_id"]


def test_valid_incoming_trace_id_accepted(client, auth_headers):
    tid = "abc12345-trace"
    r = client.get("/v1/meta", headers={**auth_headers["viewer"], "x-trace-id": tid})
    assert r.status_code == 200
    assert r.json().get("trace_id") == tid
    assert r.headers.get("x-trace-id") == tid


def test_invalid_trace_id_replaced(client, auth_headers):
    bad = "bad tid with spaces!!"
    r = client.get("/v1/meta", headers={**auth_headers["viewer"], "x-trace-id": bad})
    assert r.status_code == 200
    tid = r.json().get("trace_id")
    assert tid and tid != bad
    assert " " not in tid


def test_x_request_id_accepted(client, auth_headers):
    tid = "req-id-abcdefgh"
    r = client.get("/v1/meta", headers={**auth_headers["viewer"], "x-request-id": tid})
    assert r.status_code == 200
    assert r.json().get("trace_id") == tid


def test_unhandled_5xx_hides_exception_text(app, auth_headers, monkeypatch):
    """B1: global handler must not echo str(exc)."""
    from fastapi.testclient import TestClient

    import core.api.app as api_mod

    def boom(_cfg):
        # Deliberately awkward text for redaction checks — avoid gitleaks generic-api-key shape.
        raise RuntimeError("LEAK_MARKER path=/tmp/hidden detail=should-not-echo-xyz")

    monkeypatch.setattr(api_mod, "api_public_root", boom)
    # raise_server_exceptions=False: assert the JSON envelope, not TestClient re-raise.
    with TestClient(app, client=("127.0.0.1", 50000), raise_server_exceptions=False) as c:
        r = c.get("/v1/meta", headers=auth_headers["viewer"])
    assert r.status_code == 500
    body = r.json()
    assert body["error"]["code"] == "internal_error"
    msg = body["error"]["message"]
    assert "LEAK_MARKER" not in msg
    assert "should-not-echo" not in msg
    assert "/tmp/hidden" not in msg
    assert "Внутренняя ошибка" in msg or "internal" in msg.lower() or "trace" in msg.lower()


def test_security_headers_present(client, auth_headers):
    r = client.get("/v1/meta", headers=auth_headers["viewer"])
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert "noindex" in (r.headers.get("X-Robots-Tag") or "")
    assert "default-src" in (r.headers.get("Content-Security-Policy") or "")
