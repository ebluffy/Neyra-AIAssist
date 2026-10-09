from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest


@pytest.fixture()
def app_with_audit(api_config: dict[str, Any], stub_agent, stub_monitor, stub_backup, tmp_path: Path):
    from core.api.app import build_app

    api_config = dict(api_config)
    api = dict(api_config["api"])
    api["audit_log_enabled"] = True
    api["audit_log_path"] = "./logs/api_audit.jsonl"
    api_config["api"] = api

    project_root = tmp_path / "project"
    (project_root / "logs").mkdir(parents=True)
    (project_root / "modules").mkdir(parents=True)
    audit = project_root / "logs" / "api_audit.jsonl"
    rows = [
        {"ts": "2026-01-01T00:00:00+00:00", "op": "login", "role": "admin", "trace_id": "t1"},
        {"ts": "2026-01-01T00:01:00+00:00", "op": "restart", "role": "admin", "trace_id": "t2"},
        {"ts": "2026-01-01T00:02:00+00:00", "op": "backup", "role": "maint", "trace_id": "t3"},
    ]
    audit.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")

    return build_app(
        api_config,
        shared_agent=stub_agent,
        shared_monitor=stub_monitor,
        shared_backup_manager=stub_backup,
        project_root=project_root,
    )


def test_audit_recent_returns_tail(app_with_audit, auth_headers):
    from fastapi.testclient import TestClient

    with TestClient(app_with_audit, client=("127.0.0.1", 50001)) as client:
        r = client.get("/v1/audit/recent?limit=2", headers=auth_headers["maint"])
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["ok"] is True
        items = body["data"]["items"]
        assert len(items) == 2
        assert items[0]["op"] == "backup"
        assert items[0]["trace_id"] == "t3"
        assert items[1]["op"] == "restart"


def test_audit_recent_forbidden_for_viewer(client, auth_headers):
    r = client.get("/v1/audit/recent?limit=5", headers=auth_headers["viewer"])
    assert r.status_code == 403
