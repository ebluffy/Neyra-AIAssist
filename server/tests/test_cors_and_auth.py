"""T0: CORS closed; basic role matrix samples."""

from __future__ import annotations


def test_no_cors_allow_origin(client, auth_headers):
    r = client.get(
        "/v1/meta",
        headers={**auth_headers["viewer"], "Origin": "https://evil.example"},
    )
    assert r.status_code == 200
    assert "access-control-allow-origin" not in {k.lower() for k in r.headers.keys()}


def test_viewer_can_meta_not_restart(client, auth_headers):
    assert client.get("/v1/meta", headers=auth_headers["viewer"]).status_code == 200
    assert client.post("/v1/system/restart", headers=auth_headers["viewer"]).status_code == 403


def test_maint_can_restart(client, auth_headers, monkeypatch):
    import core.api.app as api_mod

    scheduled: list[str] = []
    monkeypatch.setattr(
        api_mod, "_schedule_exit_after_response", lambda reason="x": scheduled.append(reason)
    )
    r = client.post("/v1/system/restart", headers=auth_headers["maint"])
    assert r.status_code == 200
    assert scheduled


def test_people_requires_maint_not_viewer(client, auth_headers):
    """B5: viewer must not read PII people list."""
    r = client.get("/v1/memory/people", headers=auth_headers["viewer"])
    assert r.status_code == 403, f"viewer must not list people, got {r.status_code}"
