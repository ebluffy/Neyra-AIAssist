"""Tests for dashboard authentication endpoints (DA-01 through DA-35)."""

from __future__ import annotations

import time

import pytest

from core.api import app as api_app
from core.api.dashboard_auth import MIN_KEY_LEN


@pytest.fixture(autouse=True)
def auto_clear_rate_limit():
    """Automatically clear login rate limit state before each test."""
    api_app._DASH_LOGIN_FAILS.clear()
    yield
    # Clean up after test as well
    api_app._DASH_LOGIN_FAILS.clear()


def setup_dashboard(client, key: str = "a" * 32) -> dict:
    """
    Helper: call POST /v1/dashboard/auth/setup and return the response data.

    Args:
        client: FastAPI TestClient (already configured as loopback)
        key: Dashboard access key (default: 32 'a' characters)

    Returns:
        Response JSON data dict containing 'configured' and 'session_token'
    """
    r = client.post("/v1/dashboard/auth/setup", json={"key": key})
    assert r.status_code == 200, f"setup failed with {r.status_code}: {r.text}"
    data = r.json()
    assert data["ok"] is True
    return data["data"]


def login_dashboard(client, key: str) -> str:
    """
    Helper: call POST /v1/dashboard/auth/login and return the session token.

    Args:
        client: FastAPI TestClient
        key: Dashboard access key

    Returns:
        Session token string (Bearer token for authenticated requests)
    """
    r = client.post("/v1/dashboard/auth/login", json={"key": key})
    assert r.status_code == 200, f"login failed with {r.status_code}: {r.text}"
    data = r.json()
    assert data["ok"] is True
    return data["data"]["session_token"]


def verify_session_works(client, token: str) -> bool:
    """
    Helper: verify that a session token grants access to a protected endpoint.

    Args:
        client: FastAPI TestClient
        token: Session token to test

    Returns:
        True if the session token is valid and grants access
    """
    r = client.get("/v1/meta", headers={"Authorization": f"Bearer {token}"})
    return r.status_code == 200


def test_status_not_configured(client):
    """DA-01: GET /v1/dashboard/auth/status returns configured=false initially."""
    r = client.get("/v1/dashboard/auth/status")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["data"]["configured"] is False


def test_status_after_setup(client):
    """DA-02: GET /v1/dashboard/auth/status returns configured=true after setup."""
    setup_dashboard(client)

    r = client.get("/v1/dashboard/auth/status")
    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["data"]["configured"] is True


def test_setup_from_loopback(client):
    """DA-03: POST /v1/dashboard/auth/setup succeeds from loopback client."""
    key = "b" * 32
    r = client.post("/v1/dashboard/auth/setup", json={"key": key})

    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["data"]["configured"] is True
    assert "session_token" in data["data"]
    assert isinstance(data["data"]["session_token"], str)
    assert len(data["data"]["session_token"]) > 0


def test_setup_with_primary_token(client, auth_headers):
    """DA-04: POST /v1/dashboard/auth/setup succeeds with primary API token (admin Bearer)."""
    key = "c" * 32
    r = client.post(
        "/v1/dashboard/auth/setup",
        json={"key": key},
        headers=auth_headers["admin"],
    )

    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["data"]["configured"] is True
    assert "session_token" in data["data"]


def test_setup_fails_remote_no_auth(client):
    """DA-05: POST /v1/dashboard/auth/setup fails with remote IP (X-Real-IP) and no Bearer → 403."""
    key = "d" * 32
    r = client.post(
        "/v1/dashboard/auth/setup",
        json={"key": key},
        headers={"X-Real-IP": "203.0.113.42"},
    )

    assert r.status_code == 403
    data = r.json()
    assert data["ok"] is False
    assert "localhost console" in data["error"]["message"] or "primary API Bearer" in data["error"]["message"]


def test_setup_fails_non_primary_token(client, auth_headers):
    """DA-06: POST /v1/dashboard/auth/setup fails with viewer token → 403."""
    key = "e" * 32
    r = client.post(
        "/v1/dashboard/auth/setup",
        json={"key": key},
        headers={**auth_headers["viewer"], "X-Real-IP": "203.0.113.42"},
    )

    assert r.status_code == 403
    data = r.json()
    assert data["ok"] is False


def test_setup_fails_short_key(client):
    """DA-07: POST /v1/dashboard/auth/setup fails with key < MIN_KEY_LEN → 400."""
    short_key = "x" * (MIN_KEY_LEN - 1)
    r = client.post("/v1/dashboard/auth/setup", json={"key": short_key})

    assert r.status_code == 400
    data = r.json()
    assert data["ok"] is False
    assert "at least" in data["error"]["message"] or str(MIN_KEY_LEN) in data["error"]["message"]


def test_setup_already_configured(client):
    """DA-08: POST /v1/dashboard/auth/setup fails on second call → 409."""
    key = "f" * 32
    setup_dashboard(client, key)

    r = client.post("/v1/dashboard/auth/setup", json={"key": "g" * 32})

    assert r.status_code == 409
    data = r.json()
    assert data["ok"] is False
    assert "already" in data["error"]["message"].lower()


def test_setup_returns_valid_session(client):
    """DA-09: POST /v1/dashboard/auth/setup returns a session_token that works for authentication."""
    key = "h" * 32
    result = setup_dashboard(client, key)

    session_token = result["session_token"]
    assert session_token
    assert isinstance(session_token, str)

    # Verify the session token works
    assert verify_session_works(client, session_token) is True


# ========== Login Tests (DA-10 to DA-15) ==========


def test_login_success(client):
    """DA-10: POST /v1/dashboard/auth/login succeeds with correct key."""
    key = "login_key_1" * 3  # 33 chars
    setup_dashboard(client, key)

    r = client.post("/v1/dashboard/auth/login", json={"key": key})

    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert "session_token" in data["data"]
    assert isinstance(data["data"]["session_token"], str)
    assert len(data["data"]["session_token"]) > 0


def test_login_wrong_key(client):
    """DA-11: POST /v1/dashboard/auth/login fails with wrong key → 401."""
    key = "correct_key" + "x" * 21
    setup_dashboard(client, key)

    r = client.post("/v1/dashboard/auth/login", json={"key": "wrong_key" + "y" * 23})

    assert r.status_code == 401
    data = r.json()
    assert data["ok"] is False
    assert "invalid" in data["error"]["message"].lower() or "incorrect" in data["error"]["message"].lower()


def test_login_not_configured(client):
    """DA-12: POST /v1/dashboard/auth/login fails if dashboard not configured → 400."""

    r = client.post("/v1/dashboard/auth/login", json={"key": "a" * 32})

    assert r.status_code == 400
    data = r.json()
    assert data["ok"] is False
    assert "setup_required" in data["error"]["code"].lower() or "create" in data["error"]["message"].lower()


def test_login_rate_limit(client, monkeypatch):
    """DA-13: POST /v1/dashboard/auth/login enforces rate limit after 5 failed attempts → 429."""
    key = "rate_limit_key" + "z" * 18
    setup_dashboard(client, key)

    # Mock time.time() to control rate limit window
    mock_time = 1000.0
    monkeypatch.setattr(time, "time", lambda: mock_time)

    # Make 5 failed attempts
    for i in range(5):
        r = client.post("/v1/dashboard/auth/login", json={"key": "wrong_key" + str(i) * 22})
        assert r.status_code == 401

    # 6th attempt should be rate limited
    r = client.post("/v1/dashboard/auth/login", json={"key": "wrong_key_6" * 3})

    assert r.status_code == 429
    data = r.json()
    assert data["ok"] is False
    assert "too many" in data["error"]["message"].lower() or "rate limit" in data["error"]["message"].lower()


def test_login_rate_limit_resets(client, monkeypatch):
    """DA-14: Login rate limit resets after time window passes."""
    key = "reset_key" + "a" * 23
    setup_dashboard(client, key)

    mock_time = 1000.0
    monkeypatch.setattr(time, "time", lambda: mock_time)

    # Make 5 failed attempts
    for i in range(5):
        r = client.post("/v1/dashboard/auth/login", json={"key": f"wrong_{i}" * 4})
        assert r.status_code == 401

    # 6th attempt fails with 429
    r = client.post("/v1/dashboard/auth/login", json={"key": "wrong_final" * 3})
    assert r.status_code == 429

    # Correct keys are blocked too, until the five-minute window expires.
    assert client.post("/v1/dashboard/auth/login", json={"key": key}).status_code == 429
    mock_time = 1000.0 + api_app._DASH_LOGIN_WINDOW_S - 1
    assert client.post("/v1/dashboard/auth/login", json={"key": key}).status_code == 429
    mock_time = 1000.0 + api_app._DASH_LOGIN_WINDOW_S
    monkeypatch.setattr(time, "time", lambda: mock_time)

    assert client.post("/v1/dashboard/auth/login", json={"key": "wrong" * 8}).status_code == 401
    r = client.post("/v1/dashboard/auth/login", json={"key": key})
    assert r.status_code == 200


def test_login_returns_working_session(client):
    """DA-15: POST /v1/dashboard/auth/login returns a session_token that works."""
    key = "working_session" + "b" * 17
    setup_dashboard(client, key)

    session_token = login_dashboard(client, key)

    assert verify_session_works(client, session_token) is True


# ========== Logout Tests (DA-16 to DA-18) ==========


def test_logout_success(client):
    """DA-16: POST /v1/dashboard/auth/logout invalidates current session → 200."""
    key = "logout_key" + "c" * 22
    setup_dashboard(client, key)
    session_token = login_dashboard(client, key)

    # Verify session works before logout
    assert verify_session_works(client, session_token) is True

    # Logout
    r = client.post(
        "/v1/dashboard/auth/logout",
        headers={"Authorization": f"Bearer {session_token}"}
    )

    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True

    # Verify session no longer works
    assert verify_session_works(client, session_token) is False


def test_logout_without_auth(client):
    """DA-17: POST /v1/dashboard/auth/logout without Authorization header → 401."""
    r = client.post("/v1/dashboard/auth/logout")

    assert r.status_code == 401
    data = r.json()
    assert data["ok"] is False


def test_logout_invalid_token(client):
    """DA-18: POST /v1/dashboard/auth/logout with invalid token → 401."""
    r = client.post(
        "/v1/dashboard/auth/logout",
        headers={"Authorization": "Bearer invalid_token_xyz"}
    )

    assert r.status_code == 401
    data = r.json()
    assert data["ok"] is False


def test_logout_revoked_session_returns_401(client):
    token = setup_dashboard(client)["session_token"]
    headers = {"Authorization": f"Bearer {token}"}
    assert client.post("/v1/dashboard/auth/logout", headers=headers).status_code == 200
    assert client.post("/v1/dashboard/auth/logout", headers=headers).status_code == 401


def test_locked_ip_cannot_rotate_even_with_correct_key(client, app, monkeypatch):
    key = "a" * 32
    token = setup_dashboard(client, key)["session_token"]
    now = 1000.0
    monkeypatch.setattr(time, "time", lambda: now)
    for _ in range(5):
        assert client.post("/v1/dashboard/auth/login", json={"key": "b" * 32}).status_code == 401
    rotate = app.state.dashboard_auth.rotate
    calls = []

    def tracked_rotate(*args):
        calls.append(args)
        return rotate(*args)

    monkeypatch.setattr(app.state.dashboard_auth, "rotate", tracked_rotate)
    payload = {"current_key": key, "new_key": "c" * 32}
    headers = {"Authorization": f"Bearer {token}"}
    assert client.post("/v1/dashboard/auth/rotate", json=payload, headers=headers).status_code == 429
    assert calls == []
    assert verify_session_works(client, token)
    now += api_app._DASH_LOGIN_WINDOW_S
    assert client.post("/v1/dashboard/auth/rotate", json=payload, headers=headers).status_code == 200
    assert len(calls) == 1


# ========== Rotate Key Tests (DA-19 to DA-24) ==========


def test_rotate_success(client):
    """DA-19: POST /v1/dashboard/auth/rotate changes the key → 200."""
    old_key = "old_rotate_key" + "d" * 18
    new_key = "new_rotate_key" + "e" * 18
    setup_dashboard(client, old_key)
    session_token = login_dashboard(client, old_key)

    r = client.post(
        "/v1/dashboard/auth/rotate",
        json={"current_key": old_key, "new_key": new_key},
        headers={"Authorization": f"Bearer {session_token}"}
    )

    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True
    assert data["data"]["rotated"] is True
    assert data["trace_id"] == r.headers["x-trace-id"]
    assert verify_session_works(client, data["data"]["session_token"])


def test_rotate_body_is_documented_in_openapi(app):
    operation = app.openapi()["paths"]["/v1/dashboard/auth/rotate"]["post"]
    schema = operation["requestBody"]["content"]["application/json"]["schema"]
    assert set(schema["required"]) == {"current_key", "new_key"}
    assert schema["properties"]["new_key"]["minLength"] == MIN_KEY_LEN
    assert schema["additionalProperties"] is False


def test_rotate_old_key_fails(client):
    """DA-20: After rotate, old key cannot login → 401."""
    old_key = "old_key_fail" + "f" * 20
    new_key = "new_key_works" + "g" * 19
    setup_dashboard(client, old_key)
    session_token = login_dashboard(client, old_key)

    # Rotate key
    r = client.post(
        "/v1/dashboard/auth/rotate",
        json={"current_key": old_key, "new_key": new_key},
        headers={"Authorization": f"Bearer {session_token}"}
    )
    assert r.status_code == 200

    # Try to login with old key
    r = client.post("/v1/dashboard/auth/login", json={"key": old_key})

    assert r.status_code == 401
    data = r.json()
    assert data["ok"] is False


def test_rotate_new_key_works(client):
    """DA-21: After rotate, new key can login → 200."""
    old_key = "old_key_rotate" + "h" * 18
    new_key = "new_key_rotate" + "i" * 18
    setup_dashboard(client, old_key)
    session_token = login_dashboard(client, old_key)

    # Rotate key
    r = client.post(
        "/v1/dashboard/auth/rotate",
        json={"current_key": old_key, "new_key": new_key},
        headers={"Authorization": f"Bearer {session_token}"}
    )
    assert r.status_code == 200

    # Login with new key
    new_session = login_dashboard(client, new_key)

    assert new_session
    assert verify_session_works(client, new_session) is True


def test_rotate_without_auth(client):
    """DA-22: POST /v1/dashboard/auth/rotate without Authorization → 401."""
    r = client.post(
        "/v1/dashboard/auth/rotate",
        json={"current_key": "some_old_key" + "x" * 17, "new_key": "some_new_key" + "j" * 20}
    )

    assert r.status_code == 401
    data = r.json()
    assert data["ok"] is False


def test_rotate_short_key(client):
    """DA-23: POST /v1/dashboard/auth/rotate with short new_key → 400."""
    key = "rotate_short" + "k" * 20
    setup_dashboard(client, key)
    session_token = login_dashboard(client, key)

    short_key = "x" * (MIN_KEY_LEN - 1)
    r = client.post(
        "/v1/dashboard/auth/rotate",
        json={"current_key": key, "new_key": short_key},
        headers={"Authorization": f"Bearer {session_token}"}
    )

    assert r.status_code == 400
    data = r.json()
    assert data["ok"] is False
    assert "at least" in data["error"]["message"] or str(MIN_KEY_LEN) in data["error"]["message"]


def test_rotate_invalidates_all_sessions(client):
    """DA-24: POST /v1/dashboard/auth/rotate revokes ALL sessions including current one."""
    old_key = "preserve_session" + "l" * 16
    new_key = "new_session_key" + "m" * 17
    setup_dashboard(client, old_key)
    session_token = login_dashboard(client, old_key)

    # Rotate key
    r = client.post(
        "/v1/dashboard/auth/rotate",
        json={"current_key": old_key, "new_key": new_key},
        headers={"Authorization": f"Bearer {session_token}"}
    )
    assert r.status_code == 200

    # Current session should be invalidated (rotate revokes ALL sessions)
    assert verify_session_works(client, session_token) is False

    # But can login with new key
    new_session = login_dashboard(client, new_key)
    assert verify_session_works(client, new_session) is True


# ========== Logout All Tests (DA-25 to DA-28) ==========


def test_logout_all_success(client):
    """DA-25: POST /v1/dashboard/auth/logout-all invalidates all sessions → 200."""
    key = "logout_all" + "n" * 22
    setup_dashboard(client, key)

    # Create a session (note: each login revokes previous sessions in single-session model)
    session1 = login_dashboard(client, key)

    assert verify_session_works(client, session1) is True

    # Logout all using session1
    r = client.post(
        "/v1/dashboard/auth/logout-all",
        headers={"Authorization": f"Bearer {session1}"}
    )

    assert r.status_code == 200
    data = r.json()
    assert data["ok"] is True

    # Session should be invalid
    assert verify_session_works(client, session1) is False


def test_logout_all_without_auth(client):
    """DA-26: POST /v1/dashboard/auth/logout-all without Authorization → 401."""
    r = client.post("/v1/dashboard/auth/logout-all")

    assert r.status_code == 401
    data = r.json()
    assert data["ok"] is False


def test_logout_all_invalid_token(client):
    """DA-27: POST /v1/dashboard/auth/logout-all with invalid token → 401."""
    r = client.post(
        "/v1/dashboard/auth/logout-all",
        headers={"Authorization": "Bearer totally_invalid_token"}
    )

    assert r.status_code == 401
    data = r.json()
    assert data["ok"] is False


def test_logout_all_multiple_sessions(client):
    """DA-28: POST /v1/dashboard/auth/logout-all invalidates the active session."""
    key = "multi_logout" + "o" * 20
    setup_dashboard(client, key)

    # Create a session (single-session model: each login revokes previous sessions)
    session = login_dashboard(client, key)

    # Should work
    assert verify_session_works(client, session) is True

    # Logout all
    r = client.post(
        "/v1/dashboard/auth/logout-all",
        headers={"Authorization": f"Bearer {session}"}
    )
    assert r.status_code == 200

    # Session should be invalidated
    assert verify_session_works(client, session) is False


# ========== Session Management Tests (DA-29 to DA-33) ==========


def test_session_single_session_model(client):
    """DA-29: Each login revokes previous sessions (single-session model)."""
    key = "single_session" + "p" * 18
    setup_dashboard(client, key)

    # First login
    session1 = login_dashboard(client, key)
    assert verify_session_works(client, session1) is True

    # Second login should revoke the first
    session2 = login_dashboard(client, key)
    assert session1 != session2

    # Only session2 should work
    assert verify_session_works(client, session1) is False
    assert verify_session_works(client, session2) is True


def test_session_logout_invalidates_current(client):
    """DA-30: Logging out invalidates the current session."""
    key = "logout_current" + "q" * 18
    setup_dashboard(client, key)

    # Create a session
    session1 = login_dashboard(client, key)
    assert verify_session_works(client, session1) is True

    # Logout session1
    r = client.post(
        "/v1/dashboard/auth/logout",
        headers={"Authorization": f"Bearer {session1}"}
    )
    assert r.status_code == 200

    # session1 should be invalid
    assert verify_session_works(client, session1) is False

    # Can create a new session after logout
    session2 = login_dashboard(client, key)
    assert verify_session_works(client, session2) is True


def test_session_survives_failed_logins(client, monkeypatch):
    """DA-31: Existing sessions remain valid during failed login attempts."""
    key = "survive_fails" + "r" * 19
    setup_dashboard(client, key)
    session = login_dashboard(client, key)

    assert verify_session_works(client, session) is True

    # Make failed login attempts
    mock_time = 1000.0
    monkeypatch.setattr(time, "time", lambda: mock_time)

    for i in range(3):
        r = client.post("/v1/dashboard/auth/login", json={"key": f"wrong_{i}" * 5})
        assert r.status_code == 401

    # Original session should still work
    assert verify_session_works(client, session) is True


def test_session_invalid_token_format(client):
    """DA-32: Invalid token format returns 401."""
    key = "invalid_format" + "s" * 18
    setup_dashboard(client, key)

    # Try various invalid token formats
    invalid_tokens = [
        "",
        "not-a-token",
        "Bearer extra_text",
        "a" * 10,  # too short
    ]

    for token in invalid_tokens:
        r = client.get("/v1/meta", headers={"Authorization": f"Bearer {token}"})
        assert r.status_code == 401


def test_session_missing_bearer_prefix(client):
    """DA-33: Session token without 'Bearer' prefix returns 401."""
    key = "no_bearer" + "t" * 23
    setup_dashboard(client, key)
    session = login_dashboard(client, key)

    # Try using token without Bearer prefix
    r = client.get("/v1/meta", headers={"Authorization": session})

    assert r.status_code == 401


# ========== Integration Tests (DA-34 to DA-35) ==========


def test_full_workflow_setup_login_rotate_logout(client):
    """DA-34: Full workflow: setup → login → rotate → logout works end-to-end."""
    key1 = "workflow_key1" + "u" * 19
    key2 = "workflow_key2" + "v" * 19

    # Step 1: Setup
    result = setup_dashboard(client, key1)
    setup_token = result["session_token"]
    assert verify_session_works(client, setup_token) is True

    # Step 2: Login (this revokes setup_token due to single-session model)
    login_token = login_dashboard(client, key1)
    assert verify_session_works(client, login_token) is True
    assert verify_session_works(client, setup_token) is False  # setup_token is now invalid

    # Step 3: Rotate (this revokes all sessions including login_token)
    r = client.post(
        "/v1/dashboard/auth/rotate",
        json={"current_key": key1, "new_key": key2},
        headers={"Authorization": f"Bearer {login_token}"}
    )
    assert r.status_code == 200

    # login_token is now invalid after rotate
    assert verify_session_works(client, login_token) is False

    # Step 4: Verify old key fails, new key works
    r = client.post("/v1/dashboard/auth/login", json={"key": key1})
    assert r.status_code == 401

    new_token = login_dashboard(client, key2)
    assert verify_session_works(client, new_token) is True

    # Step 5: Logout
    r = client.post(
        "/v1/dashboard/auth/logout",
        headers={"Authorization": f"Bearer {new_token}"}
    )
    assert r.status_code == 200
    assert verify_session_works(client, new_token) is False


def test_full_workflow_single_session_logout_all(client):
    """DA-35: Full workflow: single session model → logout-all works."""
    key = "single_logout_all" + "w" * 15

    # Setup
    setup_dashboard(client, key)

    # Create first session
    session1 = login_dashboard(client, key)
    assert verify_session_works(client, session1) is True

    # Create second session (revokes first due to single-session model)
    session2 = login_dashboard(client, key)
    assert verify_session_works(client, session2) is True
    assert verify_session_works(client, session1) is False  # first session is revoked

    # Logout all using session2
    r = client.post(
        "/v1/dashboard/auth/logout-all",
        headers={"Authorization": f"Bearer {session2}"}
    )
    assert r.status_code == 200

    # session2 should now be invalid
    assert verify_session_works(client, session2) is False

    # Can still login and create new session
    new_session = login_dashboard(client, key)
    assert verify_session_works(client, new_session) is True
