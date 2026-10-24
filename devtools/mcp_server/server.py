"""
Neyra MCP debug server — stdio MCP: логи, HTTP к Internal API, инъекция событий, конфиг, память.

Запуск: python server.py
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import sys
from collections import deque
from contextlib import closing
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from mcp.server.fastmcp import FastMCP

# devtools/mcp_server/server.py -> repository root; runtime lives under server/
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SERVER_ROOT = Path(os.environ.get("NEYRA_SERVER_ROOT") or REPO_ROOT / "server").resolve()
DEFAULT_API_BASE = "http://127.0.0.1:8787"

# Key leaf names that must never appear in MCP config dumps
_SECRET_KEY_RE = re.compile(
    r"(?i)^(api[_-]?key|.*_api_key|token|.*_token|secret|.*_secret|password|"
    r"authorization|api_hash|private_key|credentials?|client_secret|access_key)$"
)
_SECRET_LINE = re.compile(
    r"(?i)^([\s#>-]*[\"']?(?:[\w]+\.)*"
    r"(?:api_key|.*_api_key|token|.*_token|secret|.*_secret|password|authorization|"
    r"api_hash|private_key|credentials?|client_secret|access_key|hf_token)"
    r"[\"']?\s*:)(.+)$"
)


def _api_base() -> str:
    return os.environ.get("NEYRA_API_BASE", DEFAULT_API_BASE).rstrip("/")


def _api_headers() -> dict[str, str]:
    h: dict[str, str] = {"Accept": "application/json"}
    tok = os.environ.get("NEYRA_API_TOKEN", "").strip()
    if tok:
        h["Authorization"] = f"Bearer {tok}"
    return h


def _json_text(data: Any) -> str:
    return _redact_text(json.dumps(_redact_data(data), ensure_ascii=False, indent=2))


def _redact_text(text: str) -> str:
    text = re.sub(r"(?i)(https?://)[^\s/?#]*@", r"\1<redacted>@", text)
    text = re.sub(r"(?i)(Bearer\s+)[A-Za-z0-9._\-+/=]+", r"\1<redacted>", text)
    text = re.sub(r"(?i)([?&](?:token|access_token|api_key|key)=)[^&\s]+", r"\1<redacted>", text)
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{8,}", "<redacted>", text)
    text = re.sub(r"(?i)\b(api[_-]?key|api[_-]?token|secret|password|authorization)\s*[=:]\s*[^\s,;]+", r"\1=<redacted>", text)
    for key, secret in os.environ.items():
        if _SECRET_KEY_RE.match(key) and len(secret.strip()) >= 8:
            text = text.replace(secret, "<redacted>")
    return text


def _redact_data(data: Any) -> Any:
    if isinstance(data, dict):
        return {k: "<redacted>" if _SECRET_KEY_RE.match(str(k)) else _redact_data(v) for k, v in data.items()}
    if isinstance(data, list):
        return [_redact_data(v) for v in data]
    return data


def _runtime_config() -> dict:
    if str(SERVER_ROOT) not in sys.path:
        sys.path.insert(0, str(SERVER_ROOT))
    from core.runtime.config_loader import load_layered_config
    return load_layered_config(SERVER_ROOT, validate=False)


def _parse_system_log_from_config(server_root: Path) -> Path | None:
    cfg = server_root / "config.yaml"
    if not cfg.is_file():
        return None
    try:
        text = cfg.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    m = re.search(r"^\s*system_log:\s*[\"']?([^\"'\n#]+)", text, re.MULTILINE)
    if not m:
        return None
    rel = m.group(1).strip().strip('"').strip("'")
    if not rel:
        return None
    return (server_root / rel).resolve()


def resolve_system_log_path() -> Path:
    """Актуальный файл системного лога: env → config.yaml → существующий файл в logs/."""
    env = os.environ.get("NEYRA_LOG_PATH", "").strip()
    if env:
        return Path(env).expanduser().resolve()

    from_cfg = _parse_system_log_from_config(SERVER_ROOT)
    if from_cfg and from_cfg.is_file():
        return from_cfg

    for name in ("server/logs/system.log", "logs/system.log", "server/logs/neyra.log", "logs/neyra.log"):
        p = (REPO_ROOT / name).resolve()
        if p.is_file():
            return p

    return (SERVER_ROOT / "logs" / "system.log").resolve()


def _tail_lines(path: Path, lines: int) -> str:
    if lines <= 0:
        return ""
    if not path.is_file():
        return (
            f"Файл лога не найден: {path}\n"
            f"Подсказка: задайте NEYRA_LOG_PATH или положите config.yaml с logging.system_log "
            f"под server/ ({SERVER_ROOT})."
        )
    try:
        with path.open("rb") as f:
            f.seek(0, 2)
            start = max(0, f.tell() - 500000)
            f.seek(start)
            if start:
                f.readline()
            last = deque(f.read().decode("utf-8", errors="replace").splitlines(keepends=True), maxlen=lines)
    except OSError as e:
        return f"Не удалось прочитать лог: {path} ({e})"
    return "".join(last)


def _redact_config_yaml(text: str) -> str:
    out_lines: list[str] = []
    for line in text.splitlines():
        raw = line.rstrip("\n")
        m = _SECRET_LINE.match(raw)
        if m:
            out_lines.append(f"{m.group(1)} <redacted>")
            continue
        # Fallback: key: value where key leaf looks secret
        km = re.match(r"^(\s*[\"']?([\w.\-]+)[\"']?\s*:)(.*)$", raw)
        if km:
            leaf = km.group(2).split(".")[-1]
            if _SECRET_KEY_RE.match(leaf) and km.group(3).strip():
                out_lines.append(f"{km.group(1)} <redacted>")
                continue
        out_lines.append(line)
    return "\n".join(out_lines)


def _config_yaml_path() -> Path:
    override = os.environ.get("NEYRA_CONFIG_PATH", "").strip()
    if override:
        return Path(override).expanduser().resolve()
    return (SERVER_ROOT / "config.yaml").resolve()


mcp = FastMCP("neyra-mcp-debug")


@mcp.tool()
def read_neyra_logs(lines: int = 50) -> str:
    """Читает последние `lines` строк из актуального системного лога Нейры (по умолчанию logs/system.log из config)."""
    lines = max(1, min(int(lines), 500))
    path = resolve_system_log_path()
    header = f"[neyra log] {path} (last {lines} lines)\n---\n"
    return header + _redact_text(_tail_lines(path, lines))[-100000:]


@mcp.tool()
def neyra_api_request(method: str, endpoint: str, payload: dict[str, Any] | None = None) -> str:
    """HTTP к Internal API Нейры (база NEYRA_API_BASE, по умолчанию http://127.0.0.1:8787). Bearer — NEYRA_API_TOKEN."""
    method_u = (method or "GET").strip().upper()
    if method_u != "GET" and os.environ.get("NEYRA_MCP_ALLOW_WRITES") != "1":
        return "Read-only MCP: writes require NEYRA_MCP_ALLOW_WRITES=1 in the MCP process."
    path = endpoint.strip()
    if not path.startswith("/"):
        path = "/" + path
    parsed = urlsplit(path)
    if parsed.scheme or parsed.netloc or not parsed.path.startswith("/v1/") or ".." in path or "%" in path or parsed.fragment:
        return "Only /v1/ API paths are allowed."
    url = f"{_api_base()}{path}"
    kwargs: dict[str, Any] = {"headers": _api_headers(), "timeout": httpx.Timeout(30.0), "follow_redirects": False, "trust_env": False}
    if method_u in ("POST", "PUT", "PATCH", "DELETE") and payload is not None:
        kwargs["json"] = payload
    try:
        r = httpx.request(method_u, url, **kwargs)
    except httpx.RequestError as e:
        return f"Request failed: {type(e).__name__}"
    body = r.text[:100000]
    ct = (r.headers.get("content-type") or "").lower()
    if "application/json" in ct and body.strip():
        try:
            body = _json_text(r.json())
        except Exception:
            pass
    return _redact_text(f"{r.status_code} {r.reason_phrase}\n---\n{body}")


@mcp.tool()
def neyra_fire_event(event_type: str, payload: dict[str, Any] | None = None) -> str:
    """POST /v1/debug/fire_event — публикует событие в EventBus (source debug.fire_event, без исходящих webhooks)."""
    return neyra_api_request(
        "POST",
        "/v1/debug/fire_event",
        {"event_type": event_type, "payload": payload or {}},
    )


@mcp.tool()
def neyra_read_config() -> str:
    """Читает корневой config.yaml репозитория; значения секретных ключей маскируются (<redacted>)."""
    if os.environ.get("NEYRA_MCP_LOAD_RUNTIME") == "1":
        return _json_text(_runtime_config())
    p = _config_yaml_path()
    if not p.is_file():
        return f"Файл не найден: {p}"
    try:
        raw = p.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        return f"Ошибка чтения {p}: {e}"
    return f"[config] {p}\n---\n{_redact_text(_redact_config_yaml(raw))}"


@mcp.tool()
def neyra_write_config(config_updates: dict[str, Any]) -> str:
    """Точечное обновление через POST /v1/config/update (только разрешённые пути ядра, см. core.api)."""
    return neyra_api_request("POST", "/v1/config/update", {"updates": config_updates})


@mcp.tool()
def neyra_inspect_memory() -> str:
    """GET /v1/debug/memory — STM, agent stats, Hub (SQLite counts) + RAG/Chroma counters."""
    return neyra_api_request("GET", "/v1/debug/memory", None)


@mcp.tool()
def neyra_memory_stats() -> str:
    """GET /v1/memory/stats — STM size, Chroma records, People cache, nested Hub SQLite stats."""
    return neyra_api_request("GET", "/v1/memory/stats", None)


@mcp.tool()
def neyra_memory_policies() -> str:
    """GET /v1/memory/policies — rag_write_mode, sqlite_path, LTM/WM/emotion cfg."""
    return neyra_api_request("GET", "/v1/memory/policies", None)


@mcp.tool()
def neyra_health() -> str:
    """GET /v1/health — быстрый ping ядра и монитора (viewer-доступ при настроенных ролях)."""
    return neyra_api_request("GET", "/v1/health", None)


@mcp.tool()
def neyra_lifecycle(action: str) -> str:
    """
    POST /v1/debug/lifecycle — остановить процесс ядра (нужен admin token и NEYRA_DEBUG_LIFECYCLE=1 или debug_lifecycle_enabled в конфиге).
    action: «stop» или «restart» (на уровне ОС то же завершение; в Docker при restart:unless-stopped контейнер поднимется снова).
    """
    a = (action or "").strip().lower()
    if a not in ("stop", "restart"):
        return "action must be stop or restart"
    return neyra_api_request("POST", "/v1/debug/lifecycle", {"action": a})


def _memory_connection() -> sqlite3.Connection:
    raw = os.environ.get("NEYRA_MEMORY_DB", "").strip()
    if not raw and os.environ.get("NEYRA_MCP_LOAD_RUNTIME") == "1":
        raw = str((_runtime_config().get("memory") or {}).get("sqlite_path") or "")
    path = Path(raw or "data/memory/neyra_memory.db").expanduser()
    if not path.is_absolute():
        path = SERVER_ROOT / path
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only=ON")
    return conn


@mcp.tool()
def neyra_memory_audit() -> str:
    """Read-only SQLite counts and provenance. No messages, personal identifiers or LLM calls."""
    queries = {
        "facts_by_source": "SELECT source, count(*) count, min(created_at) first, max(created_at) last FROM person_facts GROUP BY source",
        "chat_by_day_role": "SELECT substr(ts,1,10) day,role,count(*) count FROM chat_log GROUP BY day,role ORDER BY day DESC LIMIT 90",
        "diary_by_source": "SELECT source,count(*) count FROM diary_notes GROUP BY source",
        "counts": "SELECT (SELECT count(*) FROM people) people,(SELECT count(*) FROM person_accounts) accounts,(SELECT count(*) FROM person_facts) facts",
    }
    try:
        with closing(_memory_connection()) as conn:
            return _json_text({key: [dict(r) for r in conn.execute(sql)] for key, sql in queries.items()})
    except (OSError, sqlite3.Error):
        return "Memory database unavailable or schema incompatible; no changes made."


@mcp.tool()
def neyra_memory_scopes(limit: int = 30) -> str:
    """Operator-only channel/owner identifiers for targeted history queries; no message contents."""
    try:
        with closing(_memory_connection()) as conn:
            rows = conn.execute("SELECT channel_id,user_id,count(*) messages,min(ts) first,max(ts) last FROM chat_log WHERE role IN ('user','assistant') GROUP BY channel_id,user_id ORDER BY last DESC LIMIT ?", (max(1, min(int(limit), 100)),))
            return _json_text([dict(r) for r in rows])
    except (OSError, sqlite3.Error):
        return "Memory database unavailable or schema incompatible; no changes made."


@mcp.tool()
def neyra_chat_history(channel_id: str, limit: int = 20, before: str = "", owner_id: str = "") -> str:
    """Operator-only saved dialogue in one explicit channel, newest first. Optional ISO UTC before/owner filters.
    Contains private dialogue; request only for diagnosis. Does not read Discord or run models.
    A stored excerpt cannot establish that older or unrecorded messages do not exist.
    """
    if not channel_id.strip():
        return "An explicit channel_id is required."
    clauses = ["channel_id = ?", "role IN ('user','assistant')"]
    params: list[Any] = [channel_id.strip()]
    if before:
        from datetime import datetime, timezone
        try:
            dt = datetime.fromisoformat(before.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                return "before must include a timezone."
            before = dt.astimezone(timezone.utc).isoformat()
        except ValueError:
            return "before must be an ISO timestamp with a timezone."
        clauses.append("ts < ?")
        params.append(before)
    if owner_id:
        clauses.append("user_id = ?")
        params.append(owner_id)
    params.append(max(1, min(int(limit), 100)))
    try:
        with closing(_memory_connection()) as conn:
            rows = conn.execute("SELECT id,ts,role,user_id,display_name,text,source FROM chat_log WHERE " + " AND ".join(clauses) + " ORDER BY ts DESC,id DESC LIMIT ?", params)
            return _json_text([{**dict(r), "text": r["text"][:4000]} for r in rows])
    except (OSError, sqlite3.Error):
        return "Memory database unavailable or schema incompatible; no changes made."


@mcp.tool()
def neyra_person_facts(person_id: str, limit: int = 30) -> str:
    """Operator-only facts and creation source for one known person UUID. No writes or model calls."""
    if not person_id.strip():
        return "An explicit person_id is required."
    try:
        with closing(_memory_connection()) as conn:
            rows = conn.execute("SELECT id,fact,source,created_at FROM person_facts WHERE person_id=? ORDER BY id DESC LIMIT ?", (person_id.strip(), max(1, min(int(limit), 100))))
            return _json_text([{**dict(r), "fact": r["fact"][:4000]} for r in rows])
    except (OSError, sqlite3.Error):
        return "Memory database unavailable or schema incompatible; no changes made."


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
