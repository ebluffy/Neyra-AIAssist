"""Offline debug MCP contracts; production integrations are never called."""

import asyncio
import importlib.util
import json
import os
import sqlite3
import uuid
from contextlib import closing
from pathlib import Path
from unittest.mock import Mock

import httpx
import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("neyra_debug_mcp", ROOT / "server.py")
debug = importlib.util.module_from_spec(spec)
spec.loader.exec_module(debug)


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch):
    for key in ("NEYRA_MCP_ALLOW_WRITES", "NEYRA_MCP_LOAD_RUNTIME", "NEYRA_API_TOKEN"):
        monkeypatch.delenv(key, raising=False)


@pytest.fixture()
def database(tmp_path, monkeypatch):
    path = tmp_path / "memory.db"
    with sqlite3.connect(path) as conn:
        conn.executescript("""
            CREATE TABLE people(person_id TEXT);
            CREATE TABLE person_accounts(person_id TEXT);
            CREATE TABLE person_facts(id INTEGER,person_id TEXT,fact TEXT,source TEXT,created_at TEXT);
            CREATE TABLE diary_notes(source TEXT);
            CREATE TABLE chat_log(id INTEGER,ts TEXT,role TEXT,user_id TEXT,display_name TEXT,text TEXT,source TEXT,channel_id TEXT);
            INSERT INTO people VALUES('owner');
            INSERT INTO person_facts VALUES(1,'owner','Known fact','reflection','2026-10-20T01:00:00+00:00');
            INSERT INTO chat_log VALUES(1,'2026-10-20T18:22:00+00:00','user','owner','A','Hello','discord','shared');
            INSERT INTO chat_log VALUES(2,'2026-10-20T18:23:00+00:00','user','other','B','Public reply','discord','shared');
            INSERT INTO chat_log VALUES(3,'2026-10-20T18:24:00+00:00','model_trace','owner','A','Private trace','discord','shared');
            INSERT INTO chat_log VALUES(4,'2026-10-20T18:25:00+00:00','user','other','B','Private DM','discord','private');
        """)
    monkeypatch.setenv("NEYRA_MEMORY_DB", str(path))
    return path


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE", "PATCH"])
def test_writes_require_process_opt_in(method, monkeypatch):
    request = Mock()
    monkeypatch.setattr(debug.httpx, "request", request)
    assert "Read-only" in debug.neyra_api_request(method, "/v1/config/update", {})
    request.assert_not_called()


@pytest.mark.parametrize("path", ["//elsewhere/v1/health", "https://elsewhere/v1/health", "/v1/../admin", "/v1/%2e%2e/admin", "/other", "/v1/health#fragment"])
def test_paths_cannot_escape_api(path, monkeypatch):
    request = Mock()
    monkeypatch.setattr(debug.httpx, "request", request)
    assert "Only /v1/" in debug.neyra_api_request("GET", path)
    request.assert_not_called()


def test_http_credentials_redacted_and_redirects_disabled(monkeypatch):
    secret = uuid.uuid4().hex
    monkeypatch.setenv("NEYRA_API_TOKEN", secret)
    request = Mock(return_value=httpx.Response(200, json={"nested": {"api_key": "other-secret"}, "echo": secret}))
    monkeypatch.setattr(debug.httpx, "request", request)
    result = debug.neyra_health()
    assert secret not in result and "other-secret" not in result
    assert request.call_args.kwargs["follow_redirects"] is False
    assert request.call_args.kwargs["trust_env"] is False
    assert request.call_args.kwargs["headers"]["Authorization"] == "Bearer " + secret


def test_explicit_write_opt_in_preserves_api_request(monkeypatch):
    monkeypatch.setenv("NEYRA_MCP_ALLOW_WRITES", "1")
    request = Mock(return_value=httpx.Response(403, json={"detail": "forbidden"}))
    monkeypatch.setattr(debug.httpx, "request", request)
    result = debug.neyra_write_config({"agent.conversation_mode": "brief"})
    assert "403" in result
    assert request.call_args.args[0] == "POST"
    assert request.call_args.kwargs["json"] == {"updates": {"agent.conversation_mode": "brief"}}


def test_request_errors_do_not_return_secrets(monkeypatch):
    monkeypatch.setattr(debug.httpx, "request", Mock(side_effect=httpx.ConnectError("private-secret-url")))
    assert debug.neyra_health() == "Request failed: ConnectError"


def test_log_tail_bounds_and_redacts(tmp_path, monkeypatch):
    log = tmp_path / "system.log"
    log.write_text("old\n" * 1000 + "password=private-value https://a:pass@host/path?token=query-secret\n")
    monkeypatch.setenv("NEYRA_LOG_PATH", str(log))
    result = debug.read_neyra_logs(100000)
    assert "private-value" not in result and "query-secret" not in result and "a:pass" not in result
    assert result.count("old\n") == 499


def test_history_and_facts_are_scoped_and_trace_free(database):
    rows = json.loads(debug.neyra_chat_history("shared"))
    assert [r["id"] for r in rows] == [2, 1]
    rows = json.loads(debug.neyra_chat_history("shared", owner_id="owner"))
    assert [r["id"] for r in rows] == [1]
    assert json.loads(debug.neyra_chat_history("shared", before="2026-10-20T21:22:30+03:00"))[0]["id"] == 1
    assert "timezone" in debug.neyra_chat_history("shared", before="2026-10-20T21:22:30")
    assert "required" in debug.neyra_chat_history("")
    assert json.loads(debug.neyra_chat_history("shared' OR 1=1 --")) == []
    assert json.loads(debug.neyra_person_facts("missing")) == []
    assert json.loads(debug.neyra_person_facts("owner"))[0]["source"] == "reflection"
    with closing(debug._memory_connection()) as conn:
        with pytest.raises(sqlite3.OperationalError):
            conn.execute("DELETE FROM people")


def test_audit_excludes_content_and_identifiers(database):
    result = debug.neyra_memory_audit()
    assert "Known fact" not in result and "Public reply" not in result and "owner" not in result
    assert json.loads(result)["facts_by_source"][0]["count"] == 1
    scopes = json.loads(debug.neyra_memory_scopes())
    assert len(scopes) == 3
    assert all("text" not in row for row in scopes)


def test_missing_database_is_not_created(tmp_path, monkeypatch):
    path = tmp_path / "absent.db"
    monkeypatch.setenv("NEYRA_MEMORY_DB", str(path))
    assert "unavailable" in debug.neyra_memory_audit()
    assert not path.exists()


def test_stdio_protocol(database):
    async def run():
        params = StdioServerParameters(command=os.sys.executable, args=[str(ROOT / "server.py")], env={"NEYRA_MEMORY_DB": str(database)})
        async with stdio_client(params) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                names = {tool.name for tool in (await session.list_tools()).tools}
                assert {"neyra_memory_audit", "neyra_chat_history", "neyra_person_facts"} <= names
                result = await session.call_tool("neyra_memory_audit", {})
                assert not result.isError
                assert json.loads(result.content[0].text)["counts"][0]["people"] == 1
                result = await session.call_tool("neyra_lifecycle", {"action": "stop"})
                assert "Read-only" in result.content[0].text
    asyncio.run(run())


@pytest.mark.parametrize("writes,explicit,api,expected", [
    (False, "", {"token": "admin"}, None),
    (False, "", {"viewer_token": "   ", "token": "admin"}, None),
    (False, "", {"viewer_token": "viewer", "token": "admin"}, "viewer"),
    (False, "explicit", {"token": "admin"}, "explicit"),
    (True, "", {"token": "admin", "viewer_token": "viewer"}, "admin"),
    (True, "explicit", {"token": "admin"}, "explicit"),
    (True, "", {}, None),
])
def test_remote_credentials_fail_closed(writes, explicit, api, expected, monkeypatch):
    remote_spec = importlib.util.spec_from_file_location("neyra_debug_remote", ROOT / "remote.py")
    remote = importlib.util.module_from_spec(remote_spec)
    remote_spec.loader.exec_module(remote)
    monkeypatch.setenv("NEYRA_MCP_ALLOW_WRITES", "1" if writes else "0")
    monkeypatch.setenv("NEYRA_API_TOKEN", explicit)
    if expected is None:
        with pytest.raises(RuntimeError, match="API_VIEWER_TOKEN"):
            remote.select_api_token(api)
    else:
        assert remote.select_api_token(api) == expected
