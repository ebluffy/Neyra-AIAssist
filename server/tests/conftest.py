"""Pytest fixtures for Control API (no network / LLM / Discord)."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any, Iterator
from unittest.mock import AsyncMock, MagicMock

import pytest

SERVER_ROOT = Path(__file__).resolve().parent.parent
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))


@pytest.fixture()
def data_dir(tmp_path: Path) -> Path:
    d = tmp_path / "data"
    d.mkdir(parents=True, exist_ok=True)
    (tmp_path / "logs").mkdir(parents=True, exist_ok=True)
    return d


@pytest.fixture()
def api_config(data_dir: Path, tmp_path: Path) -> dict[str, Any]:
    return {
        "paths": {"data_dir": str(data_dir)},
        "api": {
            "host": "127.0.0.1",
            "port": 8787,
            "token": "admin-secret-token-xxxxxxxx",
            "viewer_token": "viewer-secret-token-xxxxxxx",
            "maint_token": "maint-secret-token-xxxxxxxx",
            "public_base_url": "",
            "public_path_prefix": "/api",
            "audit_log_enabled": False,
            "rate_limit_requests_per_minute": 0,
            "docs_public": True,
            "websocket": {
                "idle_timeout_seconds": 5,
                "ping_interval_seconds": 20,
                "close_grace_seconds": 1,
            },
        },
        "dashboard": {"enabled": False},
        "logging": {"level": "INFO", "system_log": str(tmp_path / "logs" / "system.log")},
        "memory": {
            "chroma_db_path": str(data_dir / "memory" / "chroma_db"),
        },
        "llm": {
            "talk_model": {"provider": "openrouter", "model": "x"},
            "brain_model": {"provider": "openrouter", "model": "x"},
            "memory_model": {"provider": "openrouter", "model": "x"},
            "vision_model": {"provider": "openrouter", "model": "x"},
            "providers": {"openrouter": {"model": "x"}},
        },
    }


@pytest.fixture()
def stub_agent() -> MagicMock:
    from core.runtime.event_bus import EventBus

    agent = MagicMock()
    agent.chat = AsyncMock(return_value={"reply": "ok"})
    agent.chat_stream = AsyncMock()
    agent.start_mcp_clients = AsyncMock()
    agent.stop_mcp_clients = AsyncMock()
    agent.memory_hub = None
    agent.long_memory = MagicMock(count=MagicMock(return_value=0))
    agent.event_bus = EventBus()
    return agent


@pytest.fixture()
def stub_monitor() -> MagicMock:
    monitor = MagicMock()
    monitor.start = MagicMock()
    monitor.run_once = AsyncMock(return_value={"ok": True, "status": "ok"})
    monitor.last_report = {"ok": True}
    return monitor


@pytest.fixture()
def stub_backup() -> MagicMock:
    backup = MagicMock()
    backup.run_backup = MagicMock(return_value={"archive": "neyra-backup-test.zip", "ok": True})
    backup.list_backups = MagicMock(return_value=[])
    backup.read_last_apply_result = MagicMock(return_value=None)
    return backup


@pytest.fixture()
def app(api_config: dict[str, Any], stub_agent, stub_monitor, stub_backup, tmp_path: Path):
    """AR-58: never use live SERVER_ROOT — WebhookStore/logs must stay under tmp_path."""
    from core.api.app import build_app

    project_root = tmp_path / "project"
    (project_root / "logs").mkdir(parents=True)
    (project_root / "modules").mkdir(parents=True)
    return build_app(
        api_config,
        shared_agent=stub_agent,
        shared_monitor=stub_monitor,
        shared_backup_manager=stub_backup,
        project_root=project_root,
    )


@pytest.fixture()
def client(app) -> Iterator[Any]:
    from fastapi.testclient import TestClient

    with TestClient(app, client=("127.0.0.1", 50000)) as c:
        yield c


@pytest.fixture()
def auth_headers() -> dict[str, dict[str, str]]:
    return {
        "admin": {"Authorization": "Bearer admin-secret-token-xxxxxxxx"},
        "viewer": {"Authorization": "Bearer viewer-secret-token-xxxxxxx"},
        "maint": {"Authorization": "Bearer maint-secret-token-xxxxxxxx"},
    }
