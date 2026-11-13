"""Wave 3: admin config snapshot/write and log tail through real ASGI routes.

Offline: temporary project root, stub agent LLM rebind, no network, no secrets
in any response.
"""
import json
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from test_web_identity_review import real_api  # noqa: F401  (fixture)

ADMIN = "admin"
TOKEN_LEAK = "admin-secret-token-xxxxxxxx"
ENV_SECRET = "sk-live-secret-value-0123456789"


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    (root / "config").mkdir(parents=True, exist_ok=True)
    return root


def put_config(http, auth_headers, updates, role=ADMIN):
    return http.put("/v1/config", json={"updates": updates}, headers=auth_headers[role])


def test_config_snapshot_requires_admin(client, auth_headers):
    assert client.get("/v1/config").status_code == 401
    assert client.get("/v1/config", headers=auth_headers["viewer"]).status_code == 403
    assert client.get("/v1/config", headers=auth_headers["maint"]).status_code == 403
    assert client.get("/v1/config", headers=auth_headers[ADMIN]).status_code == 200


def test_config_snapshot_lists_lanes_without_secrets(real_api, auth_headers, monkeypatch):
    http, _agent = real_api
    monkeypatch.setenv("AIHOPE_API_KEY", ENV_SECRET)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)

    response = http.get("/v1/config", headers=auth_headers[ADMIN])
    assert response.status_code == 200
    data = response.json()["data"]

    assert set(data["lanes"]) == {"talk", "brain", "memory", "vision"}
    assert data["lanes"]["talk"]["provider"] == "openrouter"
    assert data["lanes"]["talk"]["model"] == "x"
    assert data["providers"] == ["openrouter"]
    assert "memory" in data and "limits" in data["memory"] and "autocompact" in data["memory"]
    assert data["mcp"] == {"enabled": False, "servers": []}
    assert data["secrets"]["AIHOPE_API_KEY"] == "set"
    assert data["secrets"]["OPENROUTER_API_KEY"] == "missing"
    assert data["version"]
    assert isinstance(data["uptime_seconds"], int)

    body = response.text
    assert ENV_SECRET not in body
    assert TOKEN_LEAK not in body
    # Flags only: the snapshot must not carry values for secret names.
    assert set(data["secrets"].values()) <= {"set", "missing"}


@pytest.mark.parametrize(
    "updates",
    [
        {"api.token": "x"},
        {"llm.providers.aihope.api_key": "x"},
        {"llm.talk_model.secret": "x"},
        {"paths.data_dir": "/tmp"},
        {},
    ],
)
def test_config_put_rejects_unknown_or_empty_fields(real_api, auth_headers, updates):
    http, _agent = real_api
    response = put_config(http, auth_headers, updates)
    assert response.status_code == 400
    assert response.json()["error"]["code"] in {"unknown_field", "empty_update"}


def test_config_put_rejects_unknown_provider_and_bad_values(real_api, auth_headers):
    http, _agent = real_api
    unknown = put_config(http, auth_headers, {"llm.talk_model.provider": "not-configured"})
    assert unknown.status_code == 400
    assert unknown.json()["error"]["code"] == "unknown_provider"

    for path, value in (
        ("llm.talk_model.temperature", 3.5),
        ("llm.talk_model.temperature", "hot"),
        ("llm.talk_model.context_window", 0),
        ("llm.talk_model.model", "bad model with spaces"),
        ("memory.stm_max_messages", 0),
        ("memory.session_archive.enabled", "yes"),
    ):
        response = put_config(http, auth_headers, {path: value})
        assert response.status_code == 400, (path, value, response.text)
        assert response.json()["error"]["code"] == "invalid_value"


def test_config_put_writes_lane_keeps_backup_and_audits(
    real_api, auth_headers, project, api_config, monkeypatch
):
    http, agent = real_api
    layer = project / "config" / "llm.yaml"
    layer.write_text(
        "llm:\n  talk_model:\n    provider: openrouter\n    model: old-model\n    temperature: 0.9\n",
        encoding="utf-8",
    )
    agent._setup_llm = lambda: None
    from core.agent.talk_sessions import TalkSessions

    monkeypatch.setattr(TalkSessions, "invalidate", lambda self: None)
    monkeypatch.setattr(TalkSessions, "start_warmup", lambda self: None)
    api_config["api"]["audit_log_enabled"] = True

    response = put_config(
        http,
        auth_headers,
        {"llm.talk_model.model": "new-model-1", "llm.talk_model.temperature": 0.4},
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["applied"] == {"llm.talk_model.model": "new-model-1", "llm.talk_model.temperature": 0.4}
    assert data["persisted"] == ["config/llm.yaml"]
    assert data["backups"] == ["config/llm.yaml.bak"]
    assert data["requires_restart"] is False
    assert data["restart_fields"] == []
    assert data["llm_rebound"] is True

    written = layer.read_text(encoding="utf-8")
    assert "new-model-1" in written and "old-model" not in written
    backup = project / "config" / "llm.yaml.bak"
    assert backup.is_file()
    assert "old-model" in backup.read_text(encoding="utf-8")

    audit = project / "logs" / "api_audit.jsonl"
    rows = [json.loads(line) for line in audit.read_text(encoding="utf-8").splitlines() if line.strip()]
    entry = [row for row in rows if row.get("op") == "config_write"][-1]
    assert entry["keys"] == ["llm.talk_model.model", "llm.talk_model.temperature"]
    assert entry["requires_restart"] is False
    assert ENV_SECRET not in audit.read_text(encoding="utf-8")


def test_config_put_memory_limits_require_restart(real_api, auth_headers, project):
    http, agent = real_api
    response = put_config(
        http,
        auth_headers,
        {
            "memory.stm_max_messages": 12,
            "memory.session_archive.threshold_messages": 20,
            "memory.session_archive.enabled": True,
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["requires_restart"] is True
    assert data["restart_fields"] == [
        "memory.session_archive.enabled",
        "memory.session_archive.threshold_messages",
        "memory.stm_max_messages",
    ]
    assert data["persisted"] == ["config/memory.yaml"]
    snapshot = http.get("/v1/config", headers=auth_headers[ADMIN]).json()["data"]
    assert snapshot["memory"]["limits"]["memory.stm_max_messages"] == 12
    assert snapshot["memory"]["autocompact"]["threshold_messages"] == 20

    written = (project / "config" / "memory.yaml").read_text(encoding="utf-8")
    assert "stm_max_messages: 12" in written
    assert "threshold_messages: 20" in written


def test_config_put_requires_admin(client, auth_headers):
    body = {"updates": {"llm.talk_model.model": "new-model"}}
    assert client.put("/v1/config", json=body).status_code == 401
    assert client.put("/v1/config", json=body, headers=auth_headers["viewer"]).status_code == 403
    assert client.put("/v1/config", json=body, headers=auth_headers["maint"]).status_code == 403


def test_logs_tail_requires_admin(client, auth_headers):
    assert client.get("/v1/logs/tail").status_code == 401
    assert client.get("/v1/logs/tail", headers=auth_headers["viewer"]).status_code == 403
    assert client.get("/v1/logs/tail", headers=auth_headers["maint"]).status_code == 403


def test_logs_tail_returns_redacted_lines(real_api, auth_headers, tmp_path, monkeypatch):
    http, _agent = real_api
    monkeypatch.setenv("AIHOPE_API_KEY", ENV_SECRET)
    log = tmp_path / "logs" / "system.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text(
        "\n".join(
            [
                "2026-11-13 INFO start",
                f"2026-11-13 DEBUG key={ENV_SECRET}",
                "2026-11-13 WARN Authorization: Bearer supersecret-token-123456",
                f"2026-11-13 INFO token {TOKEN_LEAK}",
                "2026-11-13 INFO ready",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    response = http.get("/v1/logs/tail?lines=4", headers=auth_headers[ADMIN])
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["file"] == "system.log"
    assert data["count"] == 4
    assert data["lines"][-1].endswith("ready")
    body = response.text
    assert ENV_SECRET not in body
    assert "supersecret-token-123456" not in body
    assert TOKEN_LEAK not in body
    assert "***" in body


def test_logs_tail_handles_missing_file(real_api, auth_headers, tmp_path):
    http, _agent = real_api
    missing = tmp_path / "logs" / "absent.log"
    if missing.exists():
        missing.unlink()
    response = http.get("/v1/logs/tail", headers=auth_headers[ADMIN])
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["missing"] is True and data["lines"] == []
    assert str(tmp_path) not in response.text


def test_logs_tail_validates_lines(client, auth_headers):
    assert client.get("/v1/logs/tail?lines=0", headers=auth_headers[ADMIN]).status_code == 422
    assert client.get("/v1/logs/tail?lines=5000", headers=auth_headers[ADMIN]).status_code == 422
