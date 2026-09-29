"""
Neyra MCP debug server — stdio MCP: логи, HTTP к Internal API, инъекция событий, конфиг, память.

Запуск: python server.py
"""

from __future__ import annotations

import json
import os
import re
from collections import deque
from pathlib import Path
from typing import Any

import httpx
from mcp.server.fastmcp import FastMCP

# devtools/mcp_server/server.py -> repository root; runtime lives under server/
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SERVER_ROOT = REPO_ROOT / "server"
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
    return json.dumps(data, ensure_ascii=False, indent=2)


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
        with path.open("r", encoding="utf-8", errors="replace") as f:
            last = deque(f, maxlen=lines)
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
    path = resolve_system_log_path()
    header = f"[neyra log] {path} (last {lines} lines)\n---\n"
    return header + _tail_lines(path, lines)


@mcp.tool()
def neyra_api_request(method: str, endpoint: str, payload: dict[str, Any] | None = None) -> str:
    """HTTP к Internal API Нейры (база NEYRA_API_BASE, по умолчанию http://127.0.0.1:8787). Bearer — NEYRA_API_TOKEN."""
    path = endpoint.strip()
    if not path.startswith("/"):
        path = "/" + path
    url = f"{_api_base()}{path}"
    method_u = (method or "GET").upper()
    kwargs: dict[str, Any] = {"headers": _api_headers(), "timeout": httpx.Timeout(120.0)}
    if method_u in ("POST", "PUT", "PATCH", "DELETE") and payload is not None:
        kwargs["json"] = payload
    try:
        r = httpx.request(method_u, url, **kwargs)
    except httpx.RequestError as e:
        return f"Request failed: {e}\nURL: {url}"
    body = r.text
    ct = (r.headers.get("content-type") or "").lower()
    if "application/json" in ct and body.strip():
        try:
            body = _json_text(r.json())
        except Exception:
            pass
    return f"{r.status_code} {r.reason_phrase}\n---\n{body}"


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
    p = _config_yaml_path()
    if not p.is_file():
        return f"Файл не найден: {p}"
    try:
        raw = p.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        return f"Ошибка чтения {p}: {e}"
    return f"[config] {p}\n---\n{_redact_config_yaml(raw)}"


@mcp.tool()
def neyra_write_config(config_updates: dict[str, Any]) -> str:
    """Точечное обновление через POST /v1/config/update (только разрешённые пути ядра, см. internal_api)."""
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


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
