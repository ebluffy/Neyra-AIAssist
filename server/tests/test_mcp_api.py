"""MCP servers admin API: migration, masking, CRUD, status and resilience (offline)."""

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from core.runtime import mcp_client
from core.runtime.config_loader import load_layered_yaml
from core.runtime.mcp_client import (
    MCPServerConfigError,
    mask_env,
    mask_url,
    migrate_servers_config,
    normalize_servers,
    validate_server_payload,
)
from test_web_identity_review import real_api  # noqa: F401  (fixture)


def write_modules(root: Path, text: str) -> Path:
    path = root / "config" / "modules.yaml"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def admin_request(path: str, headers: dict[str, str], init: dict | None = None) -> dict:
    return {"headers": headers, **(init or {})}


# --- normalization / migration ---------------------------------------------


def test_normalize_legacy_mapping_and_flat_list():
    servers, changed = normalize_servers(
        {
            "remote": "https://mcp.example/sse",
            "files": {"command": "npx", "args": ["-y", "pkg"], "env": {"TOKEN": "secret-value"}},
        }
    )
    assert changed is True
    by_name = {item["name"]: item for item in servers}
    assert by_name["remote"]["transport"] == "sse"
    assert by_name["remote"]["url"] == "https://mcp.example/sse"
    assert by_name["files"]["transport"] == "stdio"
    assert by_name["files"]["command"] == "npx"
    assert by_name["files"]["args"] == ["-y", "pkg"]
    assert by_name["files"]["env"] == {"TOKEN": "secret-value"}

    flat, changed_flat = normalize_servers(["https://one.example/mcp", {"name": "fs", "command": "npx"}])
    assert changed_flat is True
    assert [item["name"] for item in flat] == ["server_1", "fs"]
    assert flat[0]["transport"] == "sse"

    proper = [{"name": "fs", "transport": "stdio", "command": "npx"}]
    assert normalize_servers(proper)[1] is False


def test_migration_writes_yaml_backup_and_is_idempotent(tmp_path: Path):
    write_modules(
        tmp_path,
        "mcp_client:\n  enabled: false\n  servers:\n    remote: 'https://mcp.example/sse'\n",
    )
    cfg = load_layered_yaml(tmp_path)
    assert isinstance(cfg["mcp_client"]["servers"], dict)

    assert migrate_servers_config(cfg, tmp_path) is True
    written = load_layered_yaml(tmp_path)
    assert isinstance(written["mcp_client"]["servers"], list)
    assert written["mcp_client"]["servers"][0]["name"] == "remote"
    backup = tmp_path / "config" / "modules.yaml.bak"
    assert backup.is_file()
    assert "https://mcp.example/sse" in backup.read_text(encoding="utf-8")

    before = (tmp_path / "config" / "modules.yaml").read_text(encoding="utf-8")
    assert migrate_servers_config(cfg, tmp_path) is False
    assert (tmp_path / "config" / "modules.yaml").read_text(encoding="utf-8") == before


def test_mask_env_and_url_never_reveal_values():
    masked = mask_env({"TOKEN": "super-secret", "EMPTY": ""})
    assert masked == [{"name": "EMPTY", "set": False}, {"name": "TOKEN", "set": True}]
    assert "super-secret" not in str(masked)
    assert mask_url("https://user:pass@mcp.example/sse") == "https://***@mcp.example/sse"
    assert mask_url("https://mcp.example/sse") == "https://mcp.example/sse"
    assert mask_url(None) is None


@pytest.mark.parametrize(
    "payload",
    [
        {"name": "bad name", "transport": "stdio", "command": "npx"},
        {"name": "s", "transport": "ftp"},
        {"name": "s", "transport": "stdio"},
        {"name": "s", "transport": "sse"},
        {"name": "s", "transport": "stdio", "command": "npx", "env": {"1BAD": "x"}},
        {"name": "s", "transport": "stdio", "command": "npx", "env": {"OK": 1}},
        {"name": "s", "transport": "stdio", "command": "npx", "args": ["x"] * 51},
    ],
)
def test_validate_rejects_bad_payloads(payload):
    with pytest.raises(MCPServerConfigError):
        validate_server_payload(payload)


def test_validate_normalizes_good_payload():
    spec = validate_server_payload(
        {"name": "fs", "transport": "stdio", "command": " npx ", "args": ["-y", "pkg"], "env": {"TOKEN": "v"}}
    )
    assert spec == {
        "name": "fs",
        "enabled": True,
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "pkg"],
        "env": {"TOKEN": "v"},
    }


# --- API -------------------------------------------------------------------


def test_mcp_api_requires_admin(real_api, auth_headers):
    http, _agent = real_api
    paths = [
        ("get", "/v1/mcp/servers"),
        ("post", "/v1/mcp/servers"),
        ("put", "/v1/mcp/servers/x"),
        ("delete", "/v1/mcp/servers/x"),
        ("post", "/v1/mcp/servers/x/restart"),
        ("post", "/v1/mcp/reload"),
    ]
    for method, path in paths:
        call = getattr(http, method)
        assert call(path).status_code == 401, path
        assert call(path, headers=auth_headers["viewer"]).status_code == 403, path
        assert call(path, headers=auth_headers["maint"]).status_code == 403, path


def test_crud_persists_and_masks_env(real_api, auth_headers, tmp_path: Path, api_config):
    http, agent = real_api
    api_config["mcp_client"] = {"enabled": False, "servers": []}

    created = http.post(
        "/v1/mcp/servers",
        headers=auth_headers["admin"],
        json={
            "name": "fs",
            "transport": "stdio",
            "command": "npx",
            "args": ["-y", "pkg"],
            "env": {"TOKEN": "super-secret"},
        },
    )
    assert created.status_code == 200, created.text
    body = created.json()["data"]
    assert body["enabled"] is False
    item = body["servers"][0]
    assert item["name"] == "fs" and item["status"] == "disabled"
    assert item["env"] == [{"name": "TOKEN", "set": True}]
    assert "super-secret" not in created.text

    written = load_layered_yaml(tmp_path / "project")
    assert written["mcp_client"]["servers"][0]["name"] == "fs"
    # Первая запись создаёт файл; .bak появляется при изменении существующего.

    duplicate = http.post(
        "/v1/mcp/servers",
        headers=auth_headers["admin"],
        json={"name": "fs", "transport": "stdio", "command": "npx"},
    )
    assert duplicate.status_code == 409

    updated = http.put(
        "/v1/mcp/servers/fs",
        headers=auth_headers["admin"],
        json={"args": ["-y", "other"], "enabled": True},
    )
    assert updated.status_code == 200
    item = updated.json()["data"]["servers"][0]
    assert item["args"] == ["-y", "other"]
    assert item["enabled"] is True
    assert item["status"] == "disabled"  # глобально MCP выключен
    backup = tmp_path / "project" / "config" / "modules.yaml.bak"
    assert backup.is_file()
    assert 'name: fs' in backup.read_text(encoding="utf-8")

    bad = http.put("/v1/mcp/servers/fs", headers=auth_headers["admin"], json={"transport": "sse"})
    assert bad.status_code == 400
    assert http.put("/v1/mcp/servers/ghost", headers=auth_headers["admin"], json={"enabled": False}).status_code == 404

    removed = http.delete("/v1/mcp/servers/fs", headers=auth_headers["admin"])
    assert removed.status_code == 200
    assert removed.json()["data"]["servers"] == []
    assert http.delete("/v1/mcp/servers/fs", headers=auth_headers["admin"]).status_code == 404


def test_status_uses_live_manager_and_restart(real_api, auth_headers, api_config):
    http, agent = real_api
    api_config["mcp_client"] = {
        "enabled": True,
        "servers": [
            {"name": "ok", "transport": "stdio", "command": "npx"},
            {"name": "bad", "transport": "stdio", "command": "npx"},
        ],
    }
    manager = MagicMock()
    manager.status_snapshot.return_value = {
        "ok": {"state": "connected", "tools": 3, "last_error": None, "checked_at": "2026-11-14T10:00:00+00:00"},
        "bad": {"state": "error", "tools": 0, "last_error": "missing executable", "checked_at": "2026-11-14T10:00:01+00:00"},
    }
    manager.restart_server = AsyncMock(return_value=True)
    agent.mcp_manager = manager

    response = http.get("/v1/mcp/servers", headers=auth_headers["admin"])
    assert response.status_code == 200
    items = {item["name"]: item for item in response.json()["data"]["servers"]}
    assert items["ok"]["status"] == "connected" and items["ok"]["tools"] == 3
    assert items["bad"]["status"] == "error" and items["bad"]["last_error"] == "missing executable"

    restarted = http.post("/v1/mcp/servers/ok/restart", headers=auth_headers["admin"])
    assert restarted.status_code == 200
    manager.restart_server.assert_awaited_once_with("ok")
    assert http.post("/v1/mcp/servers/ghost/restart", headers=auth_headers["admin"]).status_code == 404


def test_restart_rejected_when_mcp_disabled(real_api, auth_headers, api_config):
    http, agent = real_api
    api_config["mcp_client"] = {"enabled": False, "servers": [{"name": "fs", "transport": "stdio", "command": "npx"}]}
    agent.mcp_manager = None
    assert http.post("/v1/mcp/servers/fs/restart", headers=auth_headers["admin"]).status_code == 409


def test_reload_rereads_modules_yaml(real_api, auth_headers, tmp_path: Path, api_config):
    http, _agent = real_api
    api_config["mcp_client"] = {"enabled": False, "servers": []}
    write_modules(
        tmp_path / "project",
        "mcp_client:\n  enabled: false\n  servers:\n    - name: fromfile\n      transport: sse\n      url: 'https://mcp.example/sse'\n",
    )
    response = http.post("/v1/mcp/reload", headers=auth_headers["admin"])
    assert response.status_code == 200
    names = [item["name"] for item in response.json()["data"]["servers"]]
    assert names == ["fromfile"]


def test_connection_failure_keeps_server_and_does_not_crash(real_api, auth_headers, api_config, monkeypatch):
    http, agent = real_api
    monkeypatch.setattr(mcp_client, "_HAS_MCP", False)
    api_config["mcp_client"] = {"enabled": True, "servers": []}

    created = http.post(
        "/v1/mcp/servers",
        headers=auth_headers["admin"],
        json={"name": "broken", "transport": "stdio", "command": "/nonexistent/neyra-mcp-binary"},
    )
    assert created.status_code == 200
    item = created.json()["data"]["servers"][0]
    assert item["name"] == "broken"
    assert item["status"] == "error"
    assert item["last_error"]

    # Ядро отвечает дальше, сервер остался в конфиге.
    listing = http.get("/v1/mcp/servers", headers=auth_headers["admin"])
    assert listing.status_code == 200
    assert [s["name"] for s in listing.json()["data"]["servers"]] == ["broken"]
