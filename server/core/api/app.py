"""
Neyra API (v1): FastAPI routes and ``build_app``.

Owned by the core package (``core.api``); started via ``core.runtime.run_neyra_server``.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

import httpx
import yaml
from fastapi import Depends, FastAPI, Header, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from core.runtime.win_runtime import apply_runtime_patches

apply_runtime_patches()

from core.api.dashboard_auth import DashboardAuthStore
from core.api.client_ip import is_console_local_client as _is_console_local_client
from core.api.client_ip import is_loopback_ip as _is_loopback_ip_pure
from core.api.client_ip import resolve_client_ip as _resolve_client_ip_pure
from core.neyra import NeyraAgent
from core.runtime.backup import BackupManager
from core.runtime.event_bus import CoreEvent
from core.runtime.paths import resolve_data_dir
from core.memory.ltm_maintenance import execute_ltm_summarize
from core.plugins import PluginContext, PluginLoader, run_plugin_entrypoint
from core.reflection import ReflectionEngine
from core.runtime import HealthMonitor

logger = logging.getLogger("neyra.api")

API_VERSION = "1.1.0"
_PROCESS_STARTED_AT = time.time()
_DASH_LOGIN_FAILS: dict[str, list[float]] = {}
_DASH_LOGIN_LOCK = threading.Lock()
_DASH_LOGIN_WINDOW_S = 300.0
_DASH_LOGIN_MAX_FAILS = 10

# Runtime config keys mutable via dashboard Settings (no secrets).
CONFIG_RUNTIME_ALLOWLIST: frozenset[str] = frozenset(
    {
        "llm.talk_model",
        "llm.brain_model",
        "llm.memory_model",
        "llm.vision_model",
        "llm.talk_model.model",
        "llm.talk_model.provider",
        "llm.talk_model.reply_max_tokens",
        "llm.talk_model.lyrics_reply_max_tokens",
        "llm.talk_model.temperature",
        "llm.talk_model.timeout_seconds",
        "llm.brain_model.model",
        "llm.brain_model.provider",
        "llm.brain_model.model_deep",
        "llm.brain_model.max_tokens",
        "llm.brain_model.temperature",
        "llm.brain_model.timeout_seconds",
        "llm.memory_model.model",
        "llm.memory_model.provider",
        "llm.memory_model.max_tokens",
        "llm.memory_model.temperature",
        "llm.vision_model.model",
        "llm.vision_model.provider",
        "llm.vision_model.max_tokens",
        "llm.vision_model.temperature",
        "llm.vision_model.timeout_seconds",
        "llm.vision_model.enabled",
        "llm.vision_model.use_brain_model_for_vision",
        "llm.vision_model.max_images_per_message",
        "llm.vision_model.max_image_bytes",
        "llm.vision_model.max_image_width",
        "llm.vision_model.max_image_height",
        "llm.vision_model.remember_last_image",
        "llm.vision_model.last_image_note_max_chars",
        "llm.providers.aihope.base_url",
        "llm.providers.openrouter.base_url",
        "llm.provider",
        "llm.base_url",
        "agent.fast_path.enabled",
        "logging.level",
        "memory.rag_write_mode",
        "health_monitor.enabled",
        "health_monitor.interval_seconds",
    }
)


def resolve_client_ip(request: Request) -> str:
    """Client IP for rate-limit / setup-guard behind frp (see ``core.api.client_ip``)."""
    peer = request.client.host if request.client else "unknown"
    return _resolve_client_ip_pure(peer=peer, headers=request.headers)


def _config_get_path(cfg: dict, path: str) -> Any:
    cur: Any = cfg
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def runtime_config_snapshot(cfg: dict) -> dict[str, Any]:
    """Allowlisted runtime values only (no API keys / .env secrets)."""
    out: dict[str, Any] = {}
    for key in sorted(CONFIG_RUNTIME_ALLOWLIST):
        val = _config_get_path(cfg, key)
        if val is not None:
            out[key] = val
    return out


def configured_llm_providers(cfg: dict) -> list[str]:
    """Provider ids from ``llm.providers`` (for Settings dropdowns)."""
    llm = cfg.get("llm") if isinstance(cfg.get("llm"), dict) else {}
    providers = llm.get("providers") if isinstance(llm, dict) else None
    if not isinstance(providers, dict):
        return []
    return sorted(str(k).strip() for k in providers.keys() if str(k).strip())

# Set by run_neyra_server so soft-restart can ask uvicorn to shut down cleanly.
_uvicorn_server: Any = None


def _project_root() -> Path:
    # core/api/app.py → parents[2] = server/
    return Path(__file__).resolve().parents[2]


def _dashboard_dist_path(config: dict) -> Path:
    dash = config.get("dashboard") or {}
    raw = str(dash.get("dist_path") or "dashboard/dist").strip()
    p = Path(raw)
    if not p.is_absolute():
        p = (_project_root() / p).resolve()
    return p


def _api_cfg(cfg: dict) -> dict[str, Any]:
    raw = cfg.get("api") if isinstance(cfg, dict) else None
    return raw if isinstance(raw, dict) else {}


def api_public_root(cfg: dict) -> str:
    """
    Public API root for clients/OpenAPI, e.g. https://neyra.owyx.site/api
    Empty public_base_url → empty string (local / relative).
    """
    api = _api_cfg(cfg)
    base = str(api.get("public_base_url") or "").strip().rstrip("/")
    if not base:
        return ""
    prefix = str(api.get("public_path_prefix") or "").strip()
    if prefix and not prefix.startswith("/"):
        prefix = "/" + prefix
    prefix = prefix.rstrip("/")
    return f"{base}{prefix}"


def api_public_v1(cfg: dict) -> str:
    root = api_public_root(cfg)
    return f"{root}/v1" if root else ""


def site_public_origin(cfg: dict) -> str:
    """
    Shared public origin for dashboard UI, OpenAPI hints, clients.
    Same value as api.public_base_url (no path). Empty = local-only.
    """
    api = _api_cfg(cfg if isinstance(cfg, dict) else {})
    return str(api.get("public_base_url") or "").strip().rstrip("/")


class ApiError(Exception):
    def __init__(self, code: str, message: str, status_code: int = 400):
        self.code = code
        self.message = message
        self.status_code = status_code
        super().__init__(message)


def _trace_id(request: Request) -> str:
    return str(request.headers.get("x-trace-id") or uuid.uuid4())


def _debug_lifecycle_allowed(cfg: dict) -> bool:
    """Включается через api.debug_lifecycle_enabled или NEYRA_DEBUG_LIFECYCLE=1 (удобно в Docker)."""
    if os.environ.get("NEYRA_DEBUG_LIFECYCLE", "").strip().lower() in ("1", "true", "yes"):
        return True
    ia = cfg.get("api") if isinstance(cfg.get("api"), dict) else {}
    return bool(ia.get("debug_lifecycle_enabled", False))


def _schedule_exit_after_response(reason: str = "system_restart") -> None:
    """After the HTTP response is sent, shut down the process (prefer uvicorn graceful exit)."""

    def _run() -> None:
        time.sleep(0.35)
        logger.info("Process shutdown requested via %s", reason)
        server = _uvicorn_server
        if server is not None:
            try:
                server.should_exit = True
            except Exception:
                logger.exception("Failed to signal uvicorn should_exit; falling back to os._exit")
                os._exit(1)
                return
            # uvicorn often exits 0 after should_exit — systemd Restart=on-failure would stay down.
            time.sleep(1.5)
            os._exit(1)
            return
        # Non-zero so systemd Restart=on-failure also comes back; Docker unless-stopped always restarts.
        os._exit(1)

    threading.Thread(target=_run, daemon=False, name="neyra-api-exit").start()


def _token_eq(got: str, expected: str) -> bool:
    """Constant-time compare; different lengths never match."""
    if not expected:
        return False
    a = got.encode("utf-8")
    b = expected.encode("utf-8")
    if len(a) != len(b):
        return False
    return hmac.compare_digest(a, b)


def _is_loopback_host(host: str) -> bool:
    return _is_loopback_ip_pure(host)


def api_tokens_configured(cfg: dict) -> bool:
    api = _api_cfg(cfg)
    return bool(
        str(api.get("token") or "").strip()
        or str(api.get("viewer_token") or "").strip()
        or str(api.get("maint_token") or "").strip()
    )


def assert_api_bind_safe(cfg: dict) -> None:
    """Refuse non-loopback bind when no API tokens are set (fail-closed for LAN/public)."""
    api = _api_cfg(cfg)
    host = str(api.get("host") or "127.0.0.1")
    if _is_loopback_host(host):
        return
    if api_tokens_configured(cfg):
        return
    raise RuntimeError(
        f"api.host={host!r} is not loopback but API_TOKEN / API_KEY / "
        "API_VIEWER_TOKEN / API_MAINT_TOKEN are empty. Set tokens or bind 127.0.0.1."
    )


def _err_payload(trace_id: str, code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}, "trace_id": trace_id}


def _api_token(cfg: dict) -> str:
    api_cfg = cfg.get("api") or {}
    return str(api_cfg.get("token") or "").strip()


_ROLE_RANK = {"anon": 0, "viewer": 1, "maint": 2, "admin": 3}


def _resolve_role(
    authorization: Optional[str],
    cfg: dict,
    dash_auth: Optional[DashboardAuthStore] = None,
) -> str:
    """anon — tokens unset (local loopback only; see assert_api_bind_safe). Else Bearer required.

    Accepted Bearer values: API_TOKEN / viewer / maint, or a dashboard **session**
    token issued by POST /v1/dashboard/auth/login|setup (fast hash lookup — not PBKDF2).
    """
    api = _api_cfg(cfg)
    primary = str(api.get("token") or "").strip()
    viewer = str(api.get("viewer_token") or "").strip()
    maint = str(api.get("maint_token") or "").strip()
    if not primary and not viewer and not maint:
        return "anon"
    raw = (authorization or "").strip()
    if not raw.startswith("Bearer "):
        raise ApiError("unauthorized", "Missing bearer token", 401)
    got = raw.removeprefix("Bearer ").strip()
    if _token_eq(got, primary):
        return "admin"
    if _token_eq(got, maint):
        return "maint"
    if _token_eq(got, viewer):
        return "viewer"
    if dash_auth is not None and dash_auth.verify_session(got):
        return "admin"
    raise ApiError("unauthorized", "Invalid bearer token", 401)


def _role_at_least(role: str, minimum: str) -> bool:
    # Wave 1: anon (no tokens configured) is full access only on loopback —
    # enforced at process start via assert_api_bind_safe, not per-request.
    if role == "anon":
        return True
    return _ROLE_RANK.get(role, 0) >= _ROLE_RANK.get(minimum, 0)


def _require_ws_auth(
    token_qs: Optional[str],
    authorization: Optional[str],
    cfg: dict,
    dash_auth: Optional[DashboardAuthStore] = None,
) -> str:
    """
    Same token roles as REST. Prefer Authorization: Bearer (query ?token= may hit access logs).
    Returns role name (anon/viewer/maint/admin).
    """
    api = _api_cfg(cfg)
    primary = str(api.get("token") or "").strip()
    viewer = str(api.get("viewer_token") or "").strip()
    maint = str(api.get("maint_token") or "").strip()
    if not primary and not viewer and not maint:
        return "anon"
    got = ""
    if authorization and authorization.strip().startswith("Bearer "):
        got = authorization.removeprefix("Bearer ").strip()
    elif token_qs and str(token_qs).strip():
        got = str(token_qs).strip()
    else:
        raise ApiError("unauthorized", "Missing bearer token for WebSocket", 401)
    if _token_eq(got, primary):
        return "admin"
    if _token_eq(got, maint):
        return "maint"
    if _token_eq(got, viewer):
        return "viewer"
    if dash_auth is not None and dash_auth.verify_session(got):
        return "admin"
    raise ApiError("unauthorized", "Invalid bearer token for WebSocket", 401)


def _verify_inbound_webhook_signature(secret: str, body: bytes, signature_header: Optional[str]) -> bool:
    if not secret:
        return False
    body = body if body is not None else b""
    sig_raw = (signature_header or "").strip()
    if not sig_raw:
        return False
    expected = hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    token = sig_raw
    lower = sig_raw.lower()
    if lower.startswith("sha256="):
        token = sig_raw.split("=", 1)[1].strip()
    elif lower.startswith("v1="):
        token = sig_raw.split("=", 1)[1].strip()
    got = token.strip().lower()
    try:
        return hmac.compare_digest(expected.lower(), got)
    except Exception:
        return False


_rate_limit_lock = asyncio.Lock()
_rate_limit_buckets: dict[str, list[float]] = {}


async def _rate_limit_allow(bucket_key: str, max_per_minute: int) -> bool:
    if max_per_minute <= 0:
        return True
    now = time.monotonic()
    async with _rate_limit_lock:
        dq = _rate_limit_buckets.setdefault(bucket_key, [])
        cutoff = now - 60.0
        while dq and dq[0] < cutoff:
            dq.pop(0)
        if len(dq) >= max_per_minute:
            return False
        dq.append(now)
        return True


def _parse_inbound_json_body(raw: bytes) -> dict[str, Any]:
    if not raw:
        return {}
    try:
        data = json.loads(raw.decode("utf-8"))
        return data if isinstance(data, dict) else {"raw": data}
    except Exception:
        return {"raw_text": raw.decode("utf-8", errors="replace")}


class ChatRequest(BaseModel):
    text: str = Field(min_length=1, max_length=6000)
    username: Optional[str] = Field(default=None, max_length=120)
    platform_user_id: Optional[str] = Field(default=None, max_length=120)
    channel_id: Optional[str] = Field(default=None, max_length=120)
    author_display_name: Optional[str] = Field(default=None, max_length=120)
    avatar_url: Optional[str] = Field(default=None, max_length=500)
    platform: Optional[str] = Field(default=None, max_length=40)


class DashboardGateKeyRequest(BaseModel):
    # Login may still use an older key (<32); setup enforces MIN_KEY_LEN in the store.
    key: str = Field(min_length=8, max_length=256)


class MemorySearchRequest(BaseModel):
    """Semantic RAG search. Requires user_id (dialogs scoped; shared knowledge still included)."""

    query: str = Field(min_length=1, max_length=1200)
    top_k: int = Field(default=3, ge=1, le=20)
    user_id: Optional[str] = Field(default=None, max_length=120)


class MemoryRecallRequest(BaseModel):
    """Chronological chat_log recall (SQLite), not semantic RAG. Requires user_id and/or channel_id."""

    limit: int = Field(default=20, ge=1, le=200)
    offset: int = Field(default=0, ge=0, le=100_000)
    user_id: Optional[str] = Field(default=None, max_length=120)
    channel_id: Optional[str] = Field(default=None, max_length=120)
    newest_first: bool = True


class MemoryWriteRequest(BaseModel):
    user_text: str = Field(min_length=1, max_length=6000)
    assistant_text: str = Field(min_length=1, max_length=6000)
    username: Optional[str] = Field(default=None, max_length=120)
    platform_user_id: Optional[str] = Field(default=None, max_length=120)


class MemoryAddRequest(BaseModel):
    """Один документ знаний в RAG (не пара диалога). Живая инъекция без перезапуска ядра."""

    text: str = Field(min_length=1, max_length=24000)
    metadata: dict[str, Any] = Field(default_factory=dict)


class PersonUpsertRequest(BaseModel):
    """Create/update person card (aliases + accounts; no анкетные fields)."""

    id: Optional[str] = Field(default=None, min_length=1, max_length=80)
    names: Optional[list[str]] = None
    discord_ids: Optional[list[str]] = None
    accounts: Optional[list[dict[str, Any]]] = None
    profile: dict[str, Any] = Field(default_factory=dict)  # ignored / stored as facts


class PersonMergeRequest(BaseModel):
    survivor_id: str = Field(min_length=1, max_length=80)
    source_id: str = Field(min_length=1, max_length=80)
    reason: Optional[str] = Field(default=None, max_length=500)


class MemoryWipeRequest(BaseModel):
    scopes: list[str] = Field(
        default_factory=lambda: [
            "people",
            "diary",
            "journal",
            "stm",
            "ltm",
            "chat_log",
            "working_memory",
        ]
    )


class PersonFactCreateRequest(BaseModel):
    fact: str = Field(min_length=1, max_length=4000)
    emotion_note: Optional[str] = Field(default=None, max_length=500)


class DiaryCreateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=12000)
    emotion: Optional[str] = Field(default=None, max_length=120)


class JournalCreateRequest(BaseModel):
    text: str = Field(min_length=1, max_length=12000)
    title: Optional[str] = Field(default=None, max_length=240)
    kind: Optional[str] = Field(default=None, max_length=80)


class MemoryPruneRequest(BaseModel):
    older_than_days: float = Field(default=90.0, ge=0.5, le=36500.0)
    types: Optional[list[str]] = Field(default=None)
    dry_run: bool = False


class MemoryArchiveRequest(BaseModel):
    older_than_days: float = Field(default=90.0, ge=0.5, le=36500.0)
    types: Optional[list[str]] = Field(default=None)
    dry_run: bool = False
    max_entries: int = Field(default=2000, ge=1, le=50000)


class MemorySummarizeRequest(BaseModel):
    """Архивация старых записей + опционально один digest-документ через LLM."""

    older_than_days: float = Field(default=60.0, ge=0.5, le=36500.0)
    types: Optional[list[str]] = Field(default=None)
    dry_run: bool = False
    max_entries: int = Field(default=500, ge=1, le=10000)
    compress_with_llm: bool = True


class NotifyRequest(BaseModel):
    event_type: str = Field(min_length=3, max_length=120)
    payload: dict[str, Any] = Field(default_factory=dict)
    source: str = Field(default="api.notify", max_length=120)


class FireDebugEventRequest(BaseModel):
    """Тело POST /v1/debug/fire_event — только шина EventBus (без исходящих webhooks)."""

    event_type: str = Field(min_length=1, max_length=200)
    payload: dict[str, Any] = Field(default_factory=dict)


class LifecycleDebugRequest(BaseModel):
    """POST /v1/debug/lifecycle — завершение процесса (Docker/Orchestrator поднимает снова при restart policy)."""

    action: Literal["stop", "restart"]


class ResetContextDebugRequest(BaseModel):
    """POST /v1/debug/reset_context — archive STM (session_archive) then clear short memory."""

    user_id: str = Field(..., min_length=1, max_length=120)
    channel_id: Optional[str] = Field(default=None, max_length=120)


class ConfigUpdateRequest(BaseModel):
    updates: dict[str, Any] = Field(default_factory=dict)


class PluginStateUpdateRequest(BaseModel):
    enabled: bool


class PluginConfigUpdateRequest(BaseModel):
    config: dict[str, Any] = Field(default_factory=dict)


class PluginInvokeRequest(BaseModel):
    payload: dict[str, Any] = Field(default_factory=dict)


class WebhookRouteCreateRequest(BaseModel):
    route_id: Optional[str] = Field(default=None, max_length=120)
    event_type: str = Field(min_length=1, max_length=120)
    target_url: str = Field(min_length=8, max_length=2048)
    secret: str = Field(default="", max_length=512)
    enabled: bool = True
    max_retries: int = Field(default=3, ge=0, le=10)


class WebhookRouteUpdateRequest(BaseModel):
    event_type: Optional[str] = Field(default=None, min_length=1, max_length=120)
    target_url: Optional[str] = Field(default=None, min_length=8, max_length=2048)
    secret: Optional[str] = Field(default=None, max_length=512)
    enabled: Optional[bool] = None
    max_retries: Optional[int] = Field(default=None, ge=0, le=10)


class WebhookTestRequest(BaseModel):
    payload: dict[str, Any] = Field(default_factory=dict)


class WebhookRetryRequest(BaseModel):
    delay_seconds: float = Field(default=0.0, ge=0.0, le=300.0)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


_audit_log_lock = threading.Lock()


def _audit_file_append(cfg: dict, root: Path, entry: dict[str, Any]) -> None:
    ia = cfg.get("api") if isinstance(cfg.get("api"), dict) else {}
    if not bool(ia.get("audit_log_enabled", True)):
        return
    rel = str(ia.get("audit_log_path", "./logs/api_audit.jsonl")).strip()
    path = Path(rel)
    if not path.is_absolute():
        path = root / path
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps({**entry, "ts": _utc_now()}, ensure_ascii=False) + "\n"
        with _audit_log_lock:
            path.open("a", encoding="utf-8").write(line)
    except Exception as e:
        logger.warning("audit log append failed: %s", e)


def _mask_secret(s: str) -> str:
    raw = (s or "").strip()
    if not raw:
        return ""
    if len(raw) <= 6:
        return "*" * len(raw)
    return f"{raw[:3]}...{raw[-3:]}"


class WebhookStore:
    def __init__(self, root: Path):
        self.path = root / "logs" / "webhooks_state.json"
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = asyncio.Lock()
        self._state = self._load()

    def _load(self) -> dict[str, Any]:
        if not self.path.is_file():
            return {"routes": {}, "deliveries": {}, "dlq": {}}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                return {"routes": {}, "deliveries": {}, "dlq": {}}
            raw.setdefault("routes", {})
            raw.setdefault("deliveries", {})
            raw.setdefault("dlq", {})
            return raw
        except Exception:
            return {"routes": {}, "deliveries": {}, "dlq": {}}

    async def _save(self) -> None:
        text = json.dumps(self._state, ensure_ascii=False, indent=2)
        self.path.write_text(text, encoding="utf-8")

    async def list_routes(self) -> list[dict[str, Any]]:
        async with self._lock:
            out: list[dict[str, Any]] = []
            for row in self._state["routes"].values():
                x = dict(row)
                x["secret_masked"] = _mask_secret(str(x.get("secret") or ""))
                x.pop("secret", None)
                out.append(x)
            out.sort(key=lambda r: str(r.get("route_id") or ""))
            return out

    async def get_route(self, route_id: str) -> dict[str, Any] | None:
        async with self._lock:
            row = self._state["routes"].get(route_id)
            if not isinstance(row, dict):
                return None
            out = dict(row)
            out["secret_masked"] = _mask_secret(str(out.get("secret") or ""))
            out.pop("secret", None)
            return out

    async def upsert_route(self, route: dict[str, Any]) -> dict[str, Any]:
        rid = str(route.get("route_id") or "").strip()
        if not rid:
            rid = f"route_{uuid.uuid4().hex[:10]}"
        async with self._lock:
            base = self._state["routes"].get(rid) or {}
            merged = {
                **base,
                **route,
                "route_id": rid,
                "updated_at": _utc_now(),
            }
            if "created_at" not in merged:
                merged["created_at"] = _utc_now()
            self._state["routes"][rid] = merged
            await self._save()
            out = dict(merged)
            out["secret_masked"] = _mask_secret(str(out.get("secret") or ""))
            out.pop("secret", None)
            return out

    async def delete_route(self, route_id: str) -> bool:
        async with self._lock:
            if route_id not in self._state["routes"]:
                return False
            self._state["routes"].pop(route_id, None)
            await self._save()
            return True

    async def add_delivery(self, row: dict[str, Any]) -> dict[str, Any]:
        did = f"delivery_{uuid.uuid4().hex}"
        payload = {
            "delivery_id": did,
            "created_at": _utc_now(),
            "updated_at": _utc_now(),
            **row,
        }
        async with self._lock:
            self._state["deliveries"][did] = payload
            if payload.get("status") == "failed":
                self._state["dlq"][did] = payload
            await self._save()
        return payload

    async def update_delivery(self, delivery_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        async with self._lock:
            row = self._state["deliveries"].get(delivery_id)
            if not isinstance(row, dict):
                return None
            row.update(updates)
            row["updated_at"] = _utc_now()
            self._state["deliveries"][delivery_id] = row
            if row.get("status") == "failed":
                self._state["dlq"][delivery_id] = row
            else:
                self._state["dlq"].pop(delivery_id, None)
            await self._save()
            return dict(row)

    async def list_deliveries(self, status: str = "") -> list[dict[str, Any]]:
        async with self._lock:
            rows = list(self._state["deliveries"].values())
            if status:
                rows = [r for r in rows if str(r.get("status") or "") == status]
            rows.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
            return [dict(r) for r in rows]

    async def list_dlq(self) -> list[dict[str, Any]]:
        async with self._lock:
            rows = list(self._state["dlq"].values())
            rows.sort(key=lambda r: str(r.get("created_at") or ""), reverse=True)
            return [dict(r) for r in rows]

    async def get_delivery(self, delivery_id: str) -> dict[str, Any] | None:
        async with self._lock:
            row = self._state["deliveries"].get(delivery_id)
            return dict(row) if isinstance(row, dict) else None


async def _dispatch_webhook(
    store: WebhookStore,
    route: dict[str, Any],
    payload: dict[str, Any],
    source: str,
) -> dict[str, Any]:
    max_retries = max(0, int(route.get("max_retries", 3)))
    target_url = str(route.get("target_url") or "").strip()
    if not target_url:
        return await store.add_delivery(
            {
                "route_id": route.get("route_id"),
                "event_type": route.get("event_type"),
                "source": source,
                "status": "failed",
                "attempts": 0,
                "error": "target_url is empty",
                "payload": payload,
            }
        )
    delivery = await store.add_delivery(
        {
            "route_id": route.get("route_id"),
            "event_type": route.get("event_type"),
            "source": source,
            "status": "pending",
            "attempts": 0,
            "payload": payload,
            "target_url": target_url,
        }
    )
    delivery_id = str(delivery.get("delivery_id") or "")
    secret = str(route.get("secret") or "")
    for attempt in range(max_retries + 1):
        headers = {"Content-Type": "application/json"}
        if secret:
            headers["x-neyra-webhook-secret"] = secret
        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(target_url, json=payload, headers=headers)
            ok = 200 <= resp.status_code < 300
            status = "ok" if ok else "failed"
            await store.update_delivery(
                delivery_id,
                {
                    "attempts": attempt + 1,
                    "status_code": resp.status_code,
                    "status": status,
                    "response_text": (resp.text or "")[:2000],
                    "error": "" if ok else f"HTTP {resp.status_code}",
                },
            )
            if ok:
                row = await store.get_delivery(delivery_id)
                return row or {}
        except Exception as ex:
            await store.update_delivery(
                delivery_id,
                {
                    "attempts": attempt + 1,
                    "status": "failed",
                    "error": str(ex)[:800],
                },
            )
        if attempt < max_retries:
            await asyncio.sleep(0.5 * (attempt + 1))
    row = await store.get_delivery(delivery_id)
    return row or {}


def build_app(
    config: dict,
    *,
    shared_agent: Optional[NeyraAgent] = None,
    shared_monitor: Optional[HealthMonitor] = None,
    shared_backup_manager: Optional[BackupManager] = None,
    reflection: Optional[ReflectionEngine] = None,
) -> FastAPI:
    public_root = api_public_root(config)
    openapi_servers = [{"url": public_root, "description": "public"}] if public_root else None
    app = FastAPI(
        title="Neyra API",
        version=API_VERSION,
        servers=openapi_servers,
    )
    if shared_agent is not None:
        agent = shared_agent
        if shared_monitor is None or shared_backup_manager is None:
            raise ValueError("shared_monitor and shared_backup_manager are required with shared_agent")
        monitor = shared_monitor
        backup_manager = shared_backup_manager
    else:
        agent = NeyraAgent(config)
        monitor = HealthMonitor(config, project_root=_project_root())
        backup_manager = BackupManager(config)
    app.state.agent = agent
    app.state.monitor = monitor
    app.state.backup_manager = backup_manager
    app.state.config = config
    ws_cfg = (config.get("api") or {}).get("websocket") or {}
    ws_idle_timeout = max(5, int(ws_cfg.get("idle_timeout_seconds", 60)))
    ws_ping_interval = max(2, int(ws_cfg.get("ping_interval_seconds", 20)))
    ws_close_grace = max(1, int(ws_cfg.get("close_grace_seconds", 5)))
    root = _project_root()
    webhook_store = WebhookStore(root)
    plugin_ops: dict[str, dict[str, Any]] = {}
    dash_auth = DashboardAuthStore(resolve_data_dir(root, config) / "dashboard_auth.sqlite")
    app.state.dashboard_auth = dash_auth

    @app.on_event("startup")
    async def _startup() -> None:
        if reflection is not None:
            reflection.start_scheduler()
        monitor.start()
        await monitor.run_once()
        try:
            await agent.start_mcp_clients()
        except Exception:
            logger.exception("MCP clients startup failed (non-fatal)")

    @app.on_event("shutdown")
    async def _shutdown() -> None:
        try:
            await agent.stop_mcp_clients()
        except Exception:
            logger.debug("MCP clients shutdown", exc_info=True)

    @app.exception_handler(ApiError)
    async def _api_error_handler(request: Request, exc: ApiError):
        trace_id = _trace_id(request)
        return JSONResponse(
            status_code=exc.status_code,
            content=_err_payload(trace_id, exc.code, exc.message),
            headers={"x-trace-id": trace_id},
        )

    @app.exception_handler(Exception)
    async def _unhandled_handler(request: Request, exc: Exception):
        trace_id = _trace_id(request)
        logger.exception("Unhandled API error | trace_id=%s", trace_id)
        return JSONResponse(
            status_code=500,
            content=_err_payload(trace_id, "internal_error", str(exc)[:500]),
            headers={"x-trace-id": trace_id},
        )

    class RequireRole:
        __slots__ = ("min_role",)

        def __init__(self, min_role: str):
            self.min_role = min_role

        async def __call__(
            self,
            request: Request,
            authorization: Optional[str] = Header(default=None),
        ) -> str:
            role = _resolve_role(
                authorization,
                config,
                getattr(request.app.state, "dashboard_auth", None),
            )
            if not _role_at_least(role, self.min_role):
                raise ApiError("forbidden", "Insufficient API token scope", 403)
            return role

    dep_viewer = RequireRole("viewer")
    dep_maint = RequireRole("maint")
    dep_admin = RequireRole("admin")

    ia_sec = config.get("api") if isinstance(config.get("api"), dict) else {}
    rate_rpm = int(ia_sec.get("rate_limit_requests_per_minute", 0))

    @app.middleware("http")
    async def _rate_limit_middleware(request: Request, call_next):
        path = request.url.path or ""
        if rate_rpm <= 0 or not path.startswith("/v1") or path.startswith("/v1/ws"):
            return await call_next(request)
        # Same resolver as setup/login: CF/X-Real when peer loopback; never X-Forwarded-For.
        ip = resolve_client_ip(request)
        if not await _rate_limit_allow(f"http:{ip}", rate_rpm):
            tid = _trace_id(request)
            return JSONResponse(
                status_code=429,
                content=_err_payload(tid, "rate_limited", "Too many requests"),
                headers={"x-trace-id": tid, "Retry-After": "60"},
            )
        return await call_next(request)

    def _audit(op: str, trace_id: str, role: str, extra: Optional[dict[str, Any]] = None) -> None:
        logger.info("api_audit | op=%s | trace_id=%s | role=%s", op, trace_id, role)
        row: dict[str, Any] = {"op": op, "trace_id": trace_id, "role": role}
        if extra:
            row.update(extra)
        _audit_file_append(config, root, row)

    @app.post("/v1/chat")
    async def v1_chat(body: ChatRequest, request: Request, _role: str = Depends(dep_admin)):
        trace_id = _trace_id(request)
        out = await agent.chat(
            user_message=body.text,
            username=body.username or "api_user",
            discord_user_id=body.platform_user_id,
            channel_id=body.channel_id,
            author_display_name=body.author_display_name,
            avatar_url=body.avatar_url,
        )
        return {"ok": True, "trace_id": trace_id, "data": out}

    @app.post("/v1/memory/search")
    async def v1_memory_search(body: MemorySearchRequest, request: Request, _: None = Depends(dep_viewer)):
        trace_id = _trace_id(request)
        uid = (body.user_id or "").strip() or None
        if not uid:
            raise ApiError(
                "memory_search_user_required",
                "Provide user_id; unfiltered semantic search is not allowed",
                400,
            )
        hub = getattr(agent, "memory_hub", None)
        if hub is not None:
            rows = hub.search_semantic(body.query, n_results=body.top_k, user_id=uid)
        else:
            rows = agent.long_memory.search(body.query, n_results=body.top_k, user_id=uid)
        return {"ok": True, "trace_id": trace_id, "data": {"results": rows, "user_id": uid}}

    @app.post("/v1/memory/chat/recall")
    async def v1_memory_chat_recall(body: MemoryRecallRequest, request: Request, _: None = Depends(dep_viewer)):
        """Chronological list from SQLite chat_log (Memory Hub). Requires user_id and/or channel_id."""
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)
        uid = (body.user_id or "").strip() or None
        cid = (body.channel_id or "").strip() or None
        if not uid and not cid:
            raise ApiError(
                "memory_recall_filter_required",
                "Provide user_id and/or channel_id; unfiltered chat_log recall is not allowed",
                400,
            )

        def _run() -> list[dict[str, Any]]:
            return hub.list_chat(
                user_id=uid,
                channel_id=cid,
                limit=body.limit,
                offset=body.offset,
                newest_first=body.newest_first,
            )

        rows = await asyncio.to_thread(_run)
        return {"ok": True, "trace_id": trace_id, "data": {"messages": rows, "count": len(rows)}}

    @app.post("/v1/memory/write")
    async def v1_memory_write(body: MemoryWriteRequest, request: Request, api_role: str = Depends(dep_admin)):
        trace_id = _trace_id(request)
        uid = agent.identity.resolve("api", body.platform_user_id or body.username or "unknown")
        meta = {
            "username": body.username or "api_user",
            "discord_id": body.platform_user_id or "",
            "user_id": uid,
            "source": "api",
        }
        hub = getattr(agent, "memory_hub", None)
        wrote = False
        if hub is not None:
            wrote = bool(hub.save_dialog_semantic(body.user_text, body.assistant_text, meta))
        else:
            agent.long_memory.save(body.user_text, body.assistant_text, meta)
            wrote = True
        _audit("memory_write", trace_id, api_role, {"user_id": uid, "chroma_dialog": wrote})
        return {
            "ok": True,
            "trace_id": trace_id,
            "data": {
                "written": wrote,
                "user_id": uid,
                "chroma_dialog_embed": wrote,
                "rag_write_mode": getattr(hub, "rag_write_mode", None),
            },
        }

    @app.post("/v1/memory/add")
    async def v1_memory_add(body: MemoryAddRequest, request: Request, api_role: str = Depends(dep_admin)):
        """Добавляет один фрагмент знаний в Chroma через ядро (без прямого доступа к SQLite снаружи)."""

        trace_id = _trace_id(request)

        def _run() -> tuple[bool, str]:
            hub = getattr(agent, "memory_hub", None)
            if hub is not None:
                return hub.remember_knowledge(body.text, body.metadata)
            return agent.long_memory.add_knowledge(body.text, body.metadata)

        ok, info = await asyncio.to_thread(_run)
        if not ok:
            raise ApiError("memory_add_failed", info, 400)
        _audit("memory_add", trace_id, api_role, {"id": info})
        return {"ok": True, "trace_id": trace_id, "data": {"id": info}}

    @app.post("/v1/notify")
    async def v1_notify(body: NotifyRequest, request: Request, api_role: str = Depends(dep_admin)):
        trace_id = _trace_id(request)
        agent.event_bus.publish(
            CoreEvent(
                body.event_type,
                body.source,
                body.payload,
            )
        )
        routes = await webhook_store.list_routes()
        for route in routes:
            if not bool(route.get("enabled", True)):
                continue
            if str(route.get("event_type") or "") != body.event_type:
                continue
            asyncio.create_task(
                _dispatch_webhook(
                    webhook_store,
                    route,
                    {
                        "event_type": body.event_type,
                        "source": body.source,
                        "payload": body.payload,
                        "ts": _utc_now(),
                    },
                    source="event_bus",
                )
            )
        _audit("notify", trace_id, api_role, {"event_type": body.event_type})
        return {"ok": True, "trace_id": trace_id, "data": {"published": True}}

    @app.post("/v1/debug/fire_event")
    async def v1_debug_fire_event(body: FireDebugEventRequest, request: Request, api_role: str = Depends(dep_admin)):
        """Публикует событие в EventBus с source=debug.fire_event (без доставки исходящих webhooks)."""
        trace_id = _trace_id(request)
        agent.event_bus.publish(
            CoreEvent(
                event_type=body.event_type,
                source="debug.fire_event",
                payload=body.payload,
            )
        )
        _audit("debug_fire_event", trace_id, api_role, {"event_type": body.event_type})
        return {"ok": True, "trace_id": trace_id, "data": {"published": True, "event_type": body.event_type}}

    @app.post("/v1/debug/lifecycle")
    async def v1_debug_lifecycle(
        body: LifecycleDebugRequest,
        request: Request,
        api_role: str = Depends(dep_admin),
    ):
        """
        Завершает процесс ядра (этап E1 / отладка в Docker).
        Требует admin-токен и `api.debug_lifecycle_enabled` или env NEYRA_DEBUG_LIFECYCLE=1.
        «restart» ничем не отличается от «stop» на уровне процесса; повторный запуск обеспечивает Docker/systemd.
        """
        trace_id = _trace_id(request)
        if not _debug_lifecycle_allowed(config):
            raise ApiError(
                "lifecycle_disabled",
                "Включите api.debug_lifecycle_enabled или задайте NEYRA_DEBUG_LIFECYCLE=1",
                403,
            )
        _audit("debug_lifecycle", trace_id, api_role, {"action": body.action})
        note = (
            "Процесс будет завершён. При docker compose с restart:unless-stopped контейнер перезапустится."
            if body.action == "restart"
            else "Процесс будет завершён."
        )
        _schedule_exit_after_response(reason=f"debug_lifecycle:{body.action}")
        return {"ok": True, "trace_id": trace_id, "data": {"action": body.action, "note": note}}

    @app.post("/v1/debug/reset_context")
    async def v1_debug_reset_context(
        body: ResetContextDebugRequest,
        request: Request,
        api_role: str = Depends(dep_admin),
    ):
        """Stage 2C smoke / ops: run session_archive(manual_reset) then clear STM."""
        trace_id = _trace_id(request)
        uid = (body.user_id or "").strip()
        if not uid:
            raise ApiError(
                "reset_context_user_required",
                "Provide non-empty user_id (scoped archive requires owner)",
                400,
            )
        cid = (body.channel_id or "").strip() or None
        before = len(agent.short_memory)
        arch = await agent.reset_context_async(cid, user_id=uid)
        if not isinstance(arch, dict):
            arch = {}
        after = len(agent.short_memory)
        data = {
            "stm_before": before,
            "stm_after": after,
            "user_id": uid,
            "channel_id": cid,
            "ran": bool(arch.get("ran")),
            "history_source": str(arch.get("history_source") or ""),
            "diary_written": bool(arch.get("diary_written")),
            "ltm_digest_written": bool(arch.get("ltm_digest_written")),
            "archive_reason": str(arch.get("reason") or "manual_reset"),
            "archive_messages": int(arch.get("messages") or 0),
            "archive_chars": int(arch.get("chars") or 0),
        }
        _audit("debug_reset_context", trace_id, api_role, data)
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.get("/v1/debug/memory")
    async def v1_debug_memory(request: Request, _: None = Depends(dep_viewer)):
        """Краткосрочная память (история), сводная статистика агента и счётчики RAG."""
        trace_id = _trace_id(request)
        hist = agent.short_memory.get_history()
        trimmed: list[dict[str, Any]] = []
        total_chars = 0
        max_total = 24_000
        per_msg_cap = 4000
        for m in hist:
            role = str(m.get("role") or "")
            content = str(m.get("content") or "")
            if len(content) > per_msg_cap:
                content = content[:per_msg_cap] + "... [truncated]"
            trimmed.append({"role": role, "content": content})
            total_chars += len(content)
            if total_chars >= max_total:
                trimmed.append(
                    {
                        "role": "system",
                        "content": f"... further STM messages omitted (cap ~{max_total} chars)",
                    }
                )
                break
        mem_cfg = (config.get("memory") or {}) if isinstance(config.get("memory"), dict) else {}
        hub = getattr(agent, "memory_hub", None)
        hub_stats = hub.stats() if hub is not None else {}
        if hub_stats:
            rag_records = int(hub_stats.get("chroma_records") or 0)
            rag_enabled = bool(hub_stats.get("rag_enabled", getattr(agent.long_memory, "rag_enabled", True)))
        else:
            rag_records = agent.long_memory.count()
            rag_enabled = bool(getattr(agent.long_memory, "rag_enabled", True))
        return {
            "ok": True,
            "trace_id": trace_id,
            "data": {
                "short_term_messages": trimmed,
                "agent_stats": agent.get_stats(),
                "hub": hub_stats,
                "rag": {
                    "enabled": rag_enabled,
                    "records": rag_records,
                    "embedding_model": mem_cfg.get("embedding_model"),
                    "chroma_db_path": mem_cfg.get("chroma_db_path"),
                    "rag_write_mode": mem_cfg.get("rag_write_mode")
                    or hub_stats.get("rag_write_mode"),
                    "sqlite_path": mem_cfg.get("sqlite_path") or hub_stats.get("sqlite_path"),
                },
            },
        }

    def _client_ip(request: Request) -> str:
        return resolve_client_ip(request)

    def _dash_login_rate_ok(ip: str) -> bool:
        now = time.time()
        with _DASH_LOGIN_LOCK:
            hits = [t for t in _DASH_LOGIN_FAILS.get(ip, []) if now - t < _DASH_LOGIN_WINDOW_S]
            _DASH_LOGIN_FAILS[ip] = hits
            return len(hits) < _DASH_LOGIN_MAX_FAILS

    def _dash_login_fail(ip: str) -> None:
        now = time.time()
        with _DASH_LOGIN_LOCK:
            hits = [t for t in _DASH_LOGIN_FAILS.get(ip, []) if now - t < _DASH_LOGIN_WINDOW_S]
            hits.append(now)
            _DASH_LOGIN_FAILS[ip] = hits

    @app.get("/v1/dashboard/auth/status")
    async def v1_dashboard_auth_status(request: Request):
        """Public: whether the web UI access key has been created."""
        trace_id = _trace_id(request)
        return {
            "ok": True,
            "trace_id": trace_id,
            "data": {"configured": dash_auth.is_configured()},
        }

    @app.post("/v1/dashboard/auth/setup")
    async def v1_dashboard_auth_setup(
        body: DashboardGateKeyRequest,
        request: Request,
        authorization: Optional[str] = Header(default=None),
    ):
        """
        Create the dashboard access key once.

        Setup is allowed only from a *console-local* client (socket peer loopback
        and no ``CF-Connecting-IP`` / ``X-Real-IP``), or with the primary API Bearer
        (``API_TOKEN`` / ``api.token`` only — not viewer/maint, not a dashboard session).
        This closes the frpc window where peer is always 127.0.0.1 and forged
        ``CF-Connecting-IP: 127.0.0.1`` must not count as local.
        """
        trace_id = _trace_id(request)
        peer = request.client.host if request.client else "unknown"
        local_ok = _is_console_local_client(peer=peer, headers=request.headers)
        api_ok = False
        raw = (authorization or "").strip()
        if raw.startswith("Bearer "):
            got = raw.removeprefix("Bearer ").strip()
            api = _api_cfg(config)
            # Remote bootstrap: only primary API_TOKEN (not viewer/maint — avoids privilege escalation).
            primary = str(api.get("token") or "").strip()
            if primary and _token_eq(got, primary):
                api_ok = True
        if not local_ok and not api_ok:
            raise ApiError(
                "forbidden",
                "Dashboard key setup requires localhost console (no proxy headers) or primary API Bearer",
                403,
            )
        try:
            dash_auth.setup(body.key)
        except RuntimeError as e:
            raise ApiError("already_configured", str(e), 409) from e
        except ValueError as e:
            raise ApiError("bad_request", str(e), 400) from e
        session = dash_auth.issue_session()
        return {
            "ok": True,
            "trace_id": trace_id,
            "data": {"configured": True, "session_token": session},
        }

    @app.post("/v1/dashboard/auth/login")
    async def v1_dashboard_auth_login(body: DashboardGateKeyRequest, request: Request):
        """Public: verify dashboard access key and issue a short-lived session Bearer."""
        trace_id = _trace_id(request)
        ip = _client_ip(request)
        if not _dash_login_rate_ok(ip):
            raise ApiError("rate_limited", "Too many failed login attempts", 429)
        if not dash_auth.is_configured():
            raise ApiError("setup_required", "Create a dashboard access key first", 400)
        if not dash_auth.verify(body.key):
            _dash_login_fail(ip)
            logger.info("dashboard login failed ip=%s", ip)
            raise ApiError("unauthorized", "Invalid access key", 401)
        session = dash_auth.issue_session()
        return {
            "ok": True,
            "trace_id": trace_id,
            "data": {"authenticated": True, "session_token": session},
        }

    @app.post("/v1/dashboard/auth/logout")
    async def v1_dashboard_auth_logout(
        request: Request,
        authorization: Optional[str] = Header(default=None),
    ):
        """Revoke the current dashboard session Bearer (idempotent)."""
        trace_id = _trace_id(request)
        raw = (authorization or "").strip()
        if raw.startswith("Bearer "):
            tok = raw.removeprefix("Bearer ").strip()
            if tok:
                dash_auth.revoke_session(tok)
        return {"ok": True, "trace_id": trace_id, "data": {"revoked": True}}

    @app.get("/v1/meta")
    async def v1_meta(request: Request, _: None = Depends(dep_viewer)):
        trace_id = _trace_id(request)
        pub = api_public_root(config)
        site = site_public_origin(config)
        return {
            "ok": True,
            "trace_id": trace_id,
            "data": {
                "api_version": API_VERSION,
                "public_url": pub or None,
                "public_v1": api_public_v1(config) or None,
                "dashboard_url": site or None,
                "features": {
                    "ws_chat": True,
                    "ws_audio_stub": True,
                    "dual_llm": True,
                    "sse": False,
                    "dashboard_gate": True,
                },
            },
        }

    @app.get("/v1/llm/models")
    async def v1_llm_models(request: Request, _: None = Depends(dep_viewer)):
        trace_id = _trace_id(request)
        from core.llm.profile import (
            resolve_role_provider,
            resolved_brain_model,
            resolved_memory_model,
            resolved_talk_model,
            resolved_vision_model_id,
        )

        roles_out: dict[str, Any] = {}
        for role_key, resolver in (
            ("talk_model", resolved_talk_model),
            ("brain_model", resolved_brain_model),
            ("memory_model", resolved_memory_model),
            ("vision_model", resolved_vision_model_id),
        ):
            prov = resolve_role_provider(config, role_key)
            mid = resolver(config, prov)
            short = role_key.replace("_model", "")
            roles_out[short] = {"role": role_key, "provider": prov, "model": mid}
        return {"ok": True, "trace_id": trace_id, "data": {"roles": roles_out}}

    @app.get("/v1/health")
    async def v1_health(request: Request, _: None = Depends(dep_viewer)):
        trace_id = _trace_id(request)
        # Prefer a recent cached monitor report so the dashboard stays snappy.
        rep = monitor.last_report
        need_refresh = not rep
        if rep and isinstance(rep.get("timestamp"), str):
            try:
                ts = datetime.fromisoformat(str(rep["timestamp"]))
                age = (datetime.now() - ts).total_seconds()
                need_refresh = age > 120
            except Exception:
                need_refresh = True
        if need_refresh:
            rep = await monitor.run_once()
        if isinstance(rep, dict):
            rep = dict(rep)
            rep["api_version"] = API_VERSION
            rep["version"] = API_VERSION
            rep["status"] = "ok" if rep.get("ok") else "degraded"
            rep["uptime_seconds"] = int(max(0, time.time() - _PROCESS_STARTED_AT))
            pub = api_public_root(config)
            if pub:
                rep["public_url"] = pub
            try:
                from core.llm.profile import iter_unique_provider_connections

                rep["llm_providers"] = [
                    c.provider for c in iter_unique_provider_connections(config)
                ]
            except Exception:
                logger.debug("health llm_providers enrichment failed", exc_info=True)
        return {"ok": True, "trace_id": trace_id, "data": rep}

    @app.post("/v1/system/restart")
    async def v1_system_restart(request: Request, api_role: str = Depends(dep_maint)):
        """Soft process restart: graceful uvicorn exit after response; Docker/systemd bring it back."""
        trace_id = _trace_id(request)
        _audit("system_restart", trace_id, api_role)
        _schedule_exit_after_response(reason="POST /v1/system/restart")
        return {
            "ok": True,
            "trace_id": trace_id,
            "data": {
                "action": "restart",
                "note": (
                    "Процесс скоро остановится; systemd/docker должен поднять его снова. "
                    "Дашборд подождёт ответ health — не жмите «Обновить» сразу."
                ),
            },
        }

    @app.get("/v1/memory/stats")
    async def v1_memory_stats(request: Request, _: None = Depends(dep_viewer)):
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        hub_stats = hub.stats() if hub is not None else None
        if hub_stats is not None:
            long_records = int(hub_stats.get("chroma_records") or 0)
        else:
            long_records = agent.long_memory.count()
        data: dict[str, Any] = {
            "short_memory_size": len(agent.short_memory),
            "long_memory_records": long_records,
            "people_records": (
                int(hub_stats.get("people") or 0)
                if hub_stats is not None
                else len(agent.people_db._cache)
            ),
        }
        if hub_stats is not None:
            data["hub"] = hub_stats
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.get("/v1/memory/people")
    async def v1_memory_people(
        request: Request,
        _: None = Depends(dep_viewer),
        limit: int = Query(100, ge=1, le=500),
    ):
        """List people from MemoryHub SQLite (cutover-safe)."""
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)

        def _run() -> list[dict[str, Any]]:
            rows = hub.list_people()
            out: list[dict[str, Any]] = []
            for p in rows[: max(1, int(limit))]:
                out.append(
                    {
                        "id": p.get("id"),
                        "names": p.get("names") or [],
                        "aliases": p.get("aliases") or p.get("names") or [],
                        "discord_ids": p.get("discord_ids") or [],
                        "accounts": p.get("accounts") or [],
                        "display_name": p.get("display_name") or "",
                        "profile": {},
                    }
                )
            return out

        people = await asyncio.to_thread(_run)
        return {"ok": True, "trace_id": trace_id, "data": {"people": people, "count": len(people)}}

    @app.post("/v1/memory/people")
    async def v1_memory_people_create(
        body: PersonUpsertRequest,
        request: Request,
        _: None = Depends(dep_admin),
    ):
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)
        pid = (body.id or "").strip()
        if not pid:
            base = ""
            if body.names:
                base = str(body.names[0])
            if not base and isinstance(body.profile, dict):
                base = str(body.profile.get("first_name") or body.profile.get("last_name") or "")
            import re as _re

            slug = _re.sub(r"[^a-zA-Z0-9_\-]+", "_", base.strip().lower()).strip("_") or "person"
            pid = slug[:60]

        def _run() -> dict[str, Any]:
            if hub.find_person(pid):
                raise ApiError("person_exists", f"person '{pid}' already exists", 409)
            person = hub.save_person_dossier(
                person_id=pid,
                names=list(body.names or []),
                discord_ids=list(body.discord_ids or []),
                accounts=list(body.accounts or []) if body.accounts else None,
                profile=dict(body.profile or {}),
                create=True,
            )
            pdb = getattr(agent, "people_db", None)
            if pdb is not None:
                pdb._cache[pid] = dict(person)
            return {"person": person}

        try:
            data = await asyncio.to_thread(_run)
        except ApiError:
            raise
        except Exception as e:
            raise ApiError("person_create_failed", str(e), 500) from e
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.post("/v1/memory/people/merge")
    async def v1_memory_people_merge(
        body: PersonMergeRequest,
        request: Request,
        _: None = Depends(dep_admin),
    ):
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)

        def _run() -> dict[str, Any]:
            sa = hub.find_person(body.survivor_id.strip())
            so = hub.find_person(body.source_id.strip())
            if not sa:
                raise ApiError("person_not_found", f"survivor '{body.survivor_id}' not found", 404)
            if not so:
                raise ApiError("person_not_found", f"source '{body.source_id}' not found", 404)
            out = hub.merge_people(
                str(sa["id"]),
                str(so["id"]),
                reason=(body.reason or "dashboard_merge"),
            )
            pdb = getattr(agent, "people_db", None)
            if pdb is not None:
                pdb._cache.pop(str(so["id"]), None)
                try:
                    pdb.hydrate_from_hub()
                except Exception:
                    pass
            return out

        try:
            data = await asyncio.to_thread(_run)
        except ApiError:
            raise
        except KeyError as e:
            raise ApiError("person_not_found", str(e), 404) from e
        except Exception as e:
            raise ApiError("merge_failed", str(e), 500) from e
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.get("/v1/memory/people/{person_id}")
    async def v1_memory_person(person_id: str, request: Request, _: None = Depends(dep_viewer)):
        """Person card: accounts + facts (no анкета)."""
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)
        pid = (person_id or "").strip()
        if not pid:
            raise ApiError("invalid_person_id", "person_id required", 400)

        def _run() -> dict[str, Any]:
            person = hub.find_person(pid)
            if not person:
                return {"person_id": pid, "person": None, "summary": "", "facts": [], "profile": {}}
            resolved = str(person.get("id") or "").strip() or pid
            summary = hub.get_person_summary(resolved)
            facts = hub.list_person_facts(resolved, limit=50)
            return {
                "person_id": resolved,
                "person": person,
                "accounts": person.get("accounts") or [],
                "profile": {},
                "summary": summary,
                "facts": facts,
                "legacy_fact_hints": [],
            }

        data = await asyncio.to_thread(_run)
        if not data.get("person") and not (data.get("summary") or "").strip():
            raise ApiError("person_not_found", f"person '{pid}' not found", 404)
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.patch("/v1/memory/people/{person_id}")
    async def v1_memory_person_patch(
        person_id: str,
        body: PersonUpsertRequest,
        request: Request,
        _: None = Depends(dep_admin),
    ):
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)
        pid = (person_id or "").strip()
        if not pid:
            raise ApiError("invalid_person_id", "person_id required", 400)

        def _run() -> dict[str, Any]:
            try:
                person = hub.save_person_dossier(
                    person_id=pid,
                    names=list(body.names) if body.names is not None else None,
                    discord_ids=list(body.discord_ids) if body.discord_ids is not None else None,
                    accounts=list(body.accounts) if body.accounts is not None else None,
                    profile=dict(body.profile) if body.profile is not None else None,
                    create=False,
                )
            except KeyError as e:
                raise ApiError("person_not_found", f"person '{pid}' not found", 404) from e
            pdb = getattr(agent, "people_db", None)
            if pdb is not None:
                pdb._cache[pid] = dict(person)
            return {"person": person}

        data = await asyncio.to_thread(_run)
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.delete("/v1/memory/people/{person_id}")
    async def v1_memory_person_delete(
        person_id: str,
        request: Request,
        _: None = Depends(dep_admin),
    ):
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)
        pid = (person_id or "").strip()
        if not pid:
            raise ApiError("invalid_person_id", "person_id required", 400)

        def _run() -> dict[str, Any]:
            ok = hub.delete_person(pid)
            pdb = getattr(agent, "people_db", None)
            if pdb is not None:
                pdb._cache.pop(pid, None)
            if not ok:
                raise ApiError("person_not_found", f"person '{pid}' not found", 404)
            return {"deleted": True, "person_id": pid}

        data = await asyncio.to_thread(_run)
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.post("/v1/memory/people/{person_id}/facts")
    async def v1_memory_person_fact_add(
        person_id: str,
        body: PersonFactCreateRequest,
        request: Request,
        _: None = Depends(dep_admin),
    ):
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)
        pid = (person_id or "").strip()
        if not pid:
            raise ApiError("invalid_person_id", "person_id required", 400)

        def _run() -> dict[str, Any]:
            if not hub.find_person(pid):
                raise ApiError("person_not_found", f"person '{pid}' not found", 404)
            fact_id = hub.add_person_fact(
                pid,
                fact=body.fact.strip(),
                emotion_note=(body.emotion_note or None),
                source="dashboard",
            )
            return {"fact_id": fact_id}

        data = await asyncio.to_thread(_run)
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.delete("/v1/memory/people/{person_id}/facts/{fact_id}")
    async def v1_memory_person_fact_delete(
        person_id: str,
        fact_id: int,
        request: Request,
        _: None = Depends(dep_admin),
    ):
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)
        pid = (person_id or "").strip()

        def _run() -> dict[str, Any]:
            ok = hub.delete_person_fact(pid, int(fact_id))
            if not ok:
                raise ApiError("fact_not_found", "fact not found", 404)
            return {"deleted": True, "fact_id": int(fact_id)}

        data = await asyncio.to_thread(_run)
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.get("/v1/memory/diary")
    async def v1_memory_diary(
        request: Request,
        _: None = Depends(dep_viewer),
        limit: int = Query(20, ge=1, le=200),
    ):
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)

        def _run() -> dict[str, Any]:
            rows = hub.list_diary_notes(limit=limit, newest_first=True)
            text = hub.diary_recent_text(limit=limit)
            return {"notes": rows, "text": text}

        data = await asyncio.to_thread(_run)
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.post("/v1/memory/diary")
    async def v1_memory_diary_create(
        body: DiaryCreateRequest,
        request: Request,
        _: None = Depends(dep_admin),
    ):
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)

        def _run() -> dict[str, Any]:
            note_id = hub.add_diary_note(text=body.text.strip(), emotion=body.emotion, source="dashboard")
            return {"id": note_id}

        data = await asyncio.to_thread(_run)
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.get("/v1/memory/journal")
    async def v1_memory_journal(
        request: Request,
        _: None = Depends(dep_viewer),
        limit: int = Query(20, ge=1, le=200),
    ):
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)

        def _run() -> dict[str, Any]:
            rows = hub.list_journal_entries(limit=limit, newest_first=True)
            return {"entries": rows, "count": len(rows)}

        data = await asyncio.to_thread(_run)
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.post("/v1/memory/journal")
    async def v1_memory_journal_create(
        body: JournalCreateRequest,
        request: Request,
        _: None = Depends(dep_admin),
    ):
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)

        def _run() -> dict[str, Any]:
            entry_id = hub.add_journal_entry(
                text=body.text.strip(),
                title=body.title,
                kind=body.kind or "manual",
            )
            return {"id": entry_id}

        data = await asyncio.to_thread(_run)
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.delete("/v1/memory/diary")
    async def v1_memory_diary_clear(request: Request, _: None = Depends(dep_admin)):
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)

        def _run() -> dict[str, Any]:
            n = hub.wipe(["diary"]).get("diary", 0)
            return {"deleted": n, "scope": "diary"}

        data = await asyncio.to_thread(_run)
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.delete("/v1/memory/diary/{note_id}")
    async def v1_memory_diary_delete(
        note_id: int, request: Request, _: None = Depends(dep_admin)
    ):
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)

        def _run() -> dict[str, Any]:
            ok = hub.delete_diary_note(int(note_id))
            if not ok:
                raise ApiError("diary_not_found", "diary note not found", 404)
            return {"deleted": True, "id": int(note_id)}

        data = await asyncio.to_thread(_run)
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.delete("/v1/memory/journal")
    async def v1_memory_journal_clear(request: Request, _: None = Depends(dep_admin)):
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)

        def _run() -> dict[str, Any]:
            n = hub.wipe(["journal"]).get("journal", 0)
            return {"deleted": n, "scope": "journal"}

        data = await asyncio.to_thread(_run)
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.delete("/v1/memory/journal/{entry_id}")
    async def v1_memory_journal_delete(
        entry_id: int, request: Request, _: None = Depends(dep_admin)
    ):
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)

        def _run() -> dict[str, Any]:
            ok = hub.delete_journal_entry(int(entry_id))
            if not ok:
                raise ApiError("journal_not_found", "journal entry not found", 404)
            return {"deleted": True, "id": int(entry_id)}

        data = await asyncio.to_thread(_run)
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.delete("/v1/memory/people")
    async def v1_memory_people_clear(request: Request, _: None = Depends(dep_admin)):
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)

        def _run() -> dict[str, Any]:
            n = hub.wipe(["people"]).get("people", 0)
            pdb = getattr(agent, "people_db", None)
            if pdb is not None:
                pdb._cache.clear()
            return {"deleted": n, "scope": "people"}

        data = await asyncio.to_thread(_run)
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.post("/v1/memory/wipe")
    async def v1_memory_wipe(
        body: MemoryWipeRequest,
        request: Request,
        api_role: str = Depends(dep_admin),
    ):
        trace_id = _trace_id(request)
        hub = getattr(agent, "memory_hub", None)
        if hub is None:
            raise ApiError("memory_hub_unavailable", "Memory Hub is not initialized", 503)
        scopes = [str(s).strip().lower() for s in (body.scopes or []) if str(s).strip()]
        _audit("memory_wipe", trace_id, api_role, {"scopes": scopes})

        def _run() -> dict[str, Any]:
            hub_scopes = [s for s in scopes if s != "stm"]
            counts = hub.wipe(hub_scopes) if hub_scopes else {}
            if "stm" in scopes:
                try:
                    agent.short_memory.clear()
                    counts["stm"] = 1
                except Exception:
                    counts["stm"] = 0
            if "people" in scopes:
                pdb = getattr(agent, "people_db", None)
                if pdb is not None:
                    pdb._cache.clear()
            return {"scopes": scopes, "deleted": counts}

        data = await asyncio.to_thread(_run)
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.get("/v1/memory/policies")
    async def v1_memory_policies(request: Request, _: None = Depends(dep_viewer)):
        trace_id = _trace_id(request)
        mem_cfg = config.get("memory") if isinstance(config.get("memory"), dict) else {}
        return {
            "ok": True,
            "trace_id": trace_id,
            "data": {
                "rag_enabled": bool(mem_cfg.get("rag_enabled", True)),
                "rag_write_mode": mem_cfg.get("rag_write_mode"),
                "sqlite_path": mem_cfg.get("sqlite_path"),
                "stm_max_messages": mem_cfg.get("stm_max_messages"),
                "chat_log_retention_days": mem_cfg.get("chat_log_retention_days"),
                "max_records_target": mem_cfg.get("max_records"),
                "ltm_archive_dir": str(mem_cfg.get("ltm_archive_dir", "ltm_archive")),
                "ltm_summarize_max_tokens": mem_cfg.get("ltm_summarize_max_tokens"),
                "embedding_model": mem_cfg.get("embedding_model"),
                "chroma_db_path": mem_cfg.get("chroma_db_path"),
                "ltm_auto_prune": mem_cfg.get("ltm_auto_prune"),
                "ltm_auto_summarize": mem_cfg.get("ltm_auto_summarize"),
                "ltm_cluster_merge": mem_cfg.get("ltm_cluster_merge"),
                "working_memory": mem_cfg.get("working_memory"),
                "emotional_layer": mem_cfg.get("emotional_layer"),
            },
        }

    @app.post("/v1/memory/prune")
    async def v1_memory_prune(body: MemoryPruneRequest, request: Request, api_role: str = Depends(dep_maint)):
        trace_id = _trace_id(request)
        _audit(
            "memory_prune",
            trace_id,
            api_role,
            {"older_than_days": body.older_than_days, "dry_run": body.dry_run},
        )

        def _run() -> dict[str, Any]:
            return agent.long_memory.prune_older_than(
                body.older_than_days,
                types=body.types,
                dry_run=body.dry_run,
            )

        data = await asyncio.to_thread(_run)
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.post("/v1/memory/summarize")
    async def v1_memory_summarize(body: MemorySummarizeRequest, request: Request, api_role: str = Depends(dep_maint)):
        trace_id = _trace_id(request)
        _audit(
            "memory_summarize",
            trace_id,
            api_role,
            {
                "older_than_days": body.older_than_days,
                "compress_with_llm": body.compress_with_llm,
                "dry_run": body.dry_run,
            },
        )
        data = await execute_ltm_summarize(
            agent,
            config,
            root,
            older_than_days=body.older_than_days,
            types=body.types,
            dry_run=body.dry_run,
            max_entries=body.max_entries,
            compress_with_llm=body.compress_with_llm,
            digest_source="memory_summarize_api",
        )
        return {"ok": True, "trace_id": trace_id, "data": data}

    @app.post("/v1/memory/reindex")
    async def v1_memory_reindex(request: Request, api_role: str = Depends(dep_admin)):
        """Проверка состояния индекса Chroma (полная переиндексация не требуется при persistent-коллекции)."""
        trace_id = _trace_id(request)
        _audit("memory_reindex", trace_id, api_role)
        n = agent.long_memory.count()
        return {
            "ok": True,
            "trace_id": trace_id,
            "data": {
                "records": n,
                "note": "Векторный индекс Chroma persistent; массовая переэмбеддинга не выполняется. Используйте prune/summarize.",
            },
        }

    @app.get("/v1/plugins")
    async def v1_plugins(request: Request, _: None = Depends(dep_viewer)):
        trace_id = _trace_id(request)
        loader = PluginLoader(_project_root())
        return {"ok": True, "trace_id": trace_id, "data": {"plugins": loader.list_plugins()}}

    def _find_manifest(loader: PluginLoader, plugin_id: str):
        pid = (plugin_id or "").strip().lower()
        for m in loader.discover_manifests():
            if m.id.strip().lower() == pid:
                return m
        return None

    def _plugin_config_path(manifest) -> Path:
        return manifest.plugin_dir / "config.yaml"

    @app.get("/v1/plugins/{plugin_id}")
    async def v1_plugin_get(plugin_id: str, request: Request, _: None = Depends(dep_viewer)):
        trace_id = _trace_id(request)
        loader = PluginLoader(root)
        m = _find_manifest(loader, plugin_id)
        if m is None:
            raise ApiError("not_found", f"Plugin not found: {plugin_id}", 404)
        cfg_path = _plugin_config_path(m)
        cfg: dict[str, Any] = {}
        if cfg_path.is_file():
            raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
            if isinstance(raw, dict):
                cfg = raw
        from core.runtime.snowflake import json_safe_config

        return {
            "ok": True,
            "trace_id": trace_id,
            "data": {
                "plugin": {
                    "id": m.id,
                    "name": m.name,
                    "description": m.description,
                    "version": m.version,
                    "enabled": m.enabled,
                    "lifecycle": m.lifecycle,
                    "cli_modes": m.cli_modes,
                    "main_script": m.main_script,
                    "plugin_dir": str(m.plugin_dir),
                },
                "config": json_safe_config(cfg),
            },
        }

    @app.patch("/v1/plugins/{plugin_id}")
    async def v1_plugin_patch(plugin_id: str, body: PluginStateUpdateRequest, request: Request, api_role: str = Depends(dep_admin)):
        trace_id = _trace_id(request)
        loader = PluginLoader(root)
        ok = loader.set_enabled(plugin_id, body.enabled)
        if not ok:
            raise ApiError("not_found", f"Plugin not found: {plugin_id}", 404)
        lava_note = ""
        # Discord owns managed Lavalink: off → kill JVM; on → ensure JAR (non-blocking for event loop).
        if str(plugin_id).strip().lower() == "discord":
            try:
                from modules.discord.lavalink_process import ensure_managed_lavalink, stop_managed_lavalink

                discord_dir = root / "modules" / "discord"
                if not body.enabled:
                    lava_note = await asyncio.to_thread(stop_managed_lavalink, discord_dir)
                    logger.info("plugin discord disabled → managed Lavalink: %s", lava_note)
                else:
                    # Ensure can wait up to ~90s for the port — do not block the PATCH response.
                    async def _start_lava() -> None:
                        try:
                            ok_lava, detail = await asyncio.to_thread(
                                ensure_managed_lavalink, config, discord_dir
                            )
                            logger.info(
                                "plugin discord enabled → managed Lavalink ok=%s detail=%s",
                                ok_lava,
                                detail,
                            )
                        except Exception:
                            logger.exception(
                                "Failed to start managed Lavalink after discord enable"
                            )

                    asyncio.create_task(_start_lava())
                    lava_note = "managed Lavalink start requested"
            except Exception:
                logger.exception("Failed to sync managed Lavalink after discord toggle")
                lava_note = "lavalink sync failed (see logs)"
        op_id = f"op_{uuid.uuid4().hex[:12]}"
        plugin_ops[op_id] = {
            "operation_id": op_id,
            "plugin_id": plugin_id,
            "type": "set_enabled",
            "status": "done",
            "result": {"enabled": body.enabled, "lavalink": lava_note or None},
            "ts": _utc_now(),
        }
        _audit("plugin_set_enabled", trace_id, api_role, {"plugin_id": plugin_id, "enabled": body.enabled})
        return {"ok": True, "trace_id": trace_id, "data": plugin_ops[op_id]}

    @app.get("/v1/plugins/{plugin_id}/config")
    async def v1_plugin_config_get(plugin_id: str, request: Request, _: None = Depends(dep_viewer)):
        trace_id = _trace_id(request)
        loader = PluginLoader(root)
        m = _find_manifest(loader, plugin_id)
        if m is None:
            raise ApiError("not_found", f"Plugin not found: {plugin_id}", 404)
        cfg_path = _plugin_config_path(m)
        cfg: dict[str, Any] = {}
        if cfg_path.is_file():
            raw = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
            if isinstance(raw, dict):
                cfg = raw
        from core.runtime.snowflake import json_safe_config

        return {
            "ok": True,
            "trace_id": trace_id,
            "data": {"plugin_id": m.id, "config": json_safe_config(cfg)},
        }

    @app.put("/v1/plugins/{plugin_id}/config")
    async def v1_plugin_config_put(plugin_id: str, body: PluginConfigUpdateRequest, request: Request, _: None = Depends(dep_admin)):
        trace_id = _trace_id(request)
        loader = PluginLoader(root)
        m = _find_manifest(loader, plugin_id)
        if m is None:
            raise ApiError("not_found", f"Plugin not found: {plugin_id}", 404)
        cfg_path = _plugin_config_path(m)
        from core.runtime.snowflake import json_safe_config

        # Persist snowflakes as strings so a later dashboard JSON round-trip cannot corrupt them.
        safe_cfg = json_safe_config(body.config or {})
        cfg_path.write_text(
            yaml.safe_dump(safe_cfg, allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )
        op_id = f"op_{uuid.uuid4().hex[:12]}"
        plugin_ops[op_id] = {
            "operation_id": op_id,
            "plugin_id": plugin_id,
            "type": "save_config",
            "status": "done",
            "ts": _utc_now(),
        }
        return {"ok": True, "trace_id": trace_id, "data": plugin_ops[op_id]}

    @app.post("/v1/plugins/{plugin_id}/reload")
    async def v1_plugin_reload(plugin_id: str, request: Request, _: None = Depends(dep_admin)):
        trace_id = _trace_id(request)
        loader = PluginLoader(root)
        m = _find_manifest(loader, plugin_id)
        if m is None:
            raise ApiError("not_found", f"Plugin not found: {plugin_id}", 404)
        raise ApiError(
            "not_supported",
            (
                f"In-process reload of '{plugin_id}' is not supported. "
                "Use POST /v1/system/restart for a process soft-restart, "
                "or PATCH enabled + restart."
            ),
            501,
        )

    @app.post("/v1/plugins/{plugin_id}/restart")
    async def v1_plugin_restart(plugin_id: str, request: Request, _: None = Depends(dep_admin)):
        trace_id = _trace_id(request)
        loader = PluginLoader(root)
        m = _find_manifest(loader, plugin_id)
        if m is None:
            raise ApiError("not_found", f"Plugin not found: {plugin_id}", 404)
        raise ApiError(
            "not_supported",
            (
                f"Per-plugin restart of '{plugin_id}' is not supported. "
                "Use POST /v1/system/restart (maint+) to restart the Neyra process."
            ),
            501,
        )

    @app.post("/v1/plugins/{plugin_id}/invoke")
    async def v1_plugin_invoke(plugin_id: str, body: PluginInvokeRequest, request: Request, _: None = Depends(dep_admin)):
        trace_id = _trace_id(request)
        loader = PluginLoader(root)
        m = _find_manifest(loader, plugin_id)
        if m is None:
            raise ApiError("not_found", f"Plugin not found: {plugin_id}", 404)
        if m.lifecycle != "on_demand":
            raise ApiError("bad_request", "invoke supported only for lifecycle=on_demand plugins", 400)
        mod = loader.import_plugin_module(m)
        ctx = PluginContext(root=root, config=config, agent=None)
        if callable(getattr(mod, "invoke_plugin", None)):
            result = await asyncio.to_thread(mod.invoke_plugin, body.payload, ctx)
        else:
            result = await asyncio.to_thread(run_plugin_entrypoint, mod, ctx)
        op_id = f"op_{uuid.uuid4().hex[:12]}"
        plugin_ops[op_id] = {
            "operation_id": op_id,
            "plugin_id": plugin_id,
            "type": "invoke",
            "status": "done",
            "ts": _utc_now(),
        }
        return {"ok": True, "trace_id": trace_id, "data": {"operation": plugin_ops[op_id], "result": result}}

    @app.get("/v1/plugins/operations/{operation_id}")
    async def v1_plugin_op(operation_id: str, request: Request, _: None = Depends(dep_viewer)):
        trace_id = _trace_id(request)
        row = plugin_ops.get(operation_id)
        if row is None:
            raise ApiError("not_found", f"Operation not found: {operation_id}", 404)
        return {"ok": True, "trace_id": trace_id, "data": row}

    @app.get("/v1/llm/balance")
    async def v1_llm_balance(request: Request, _: None = Depends(dep_viewer)):
        from core.llm import (
            connection_for_provider,
            fetch_aihope_token_usage,
            fetch_openrouter_key_usage,
            resolve_role_provider,
        )

        trace_id = _trace_id(request)
        default_prov = resolve_role_provider(config, None)
        roles = {
            "talk": resolve_role_provider(config, "talk_model"),
            "brain": resolve_role_provider(config, "brain_model"),
            "memory": resolve_role_provider(config, "memory_model"),
            "vision": resolve_role_provider(config, "vision_model"),
        }
        out: dict[str, Any] = {
            "default_provider": default_prov,
            "roles": roles,
            "openrouter": None,
            "aihope": None,
        }

        providers = {default_prov, *roles.values()}
        any_ok = False
        missing_all = True
        for prov in providers:
            if prov == "openrouter":
                conn = connection_for_provider(config, "openrouter")
                key = (conn.api_key or "").strip()
                if key and key != "ollama":
                    missing_all = False
                    raw = await fetch_openrouter_key_usage(key)
                    if raw.get("_error"):
                        out["openrouter"] = {
                            "_error": raw.get("_error"),
                            "detail": str(raw)[:400],
                        }
                    else:
                        any_ok = True
                        out["openrouter"] = {
                            k: v for k, v in raw.items() if not str(k).startswith("_")
                        }
                else:
                    out["openrouter"] = {"_error": "missing_api_key"}
            elif prov == "aihope":
                conn = connection_for_provider(config, "aihope")
                key = (conn.api_key or "").strip()
                if key and key != "ollama":
                    missing_all = False
                    raw = await fetch_aihope_token_usage(key)
                    if raw.get("_error"):
                        out["aihope"] = {
                            "_error": raw.get("_error"),
                            "detail": str(raw)[:400],
                        }
                    else:
                        any_ok = True
                        out["aihope"] = {
                            k: v for k, v in raw.items() if not str(k).startswith("_")
                        }
                else:
                    out["aihope"] = {"_error": "missing_api_key"}

        if missing_all:
            raise ApiError(
                "config_error",
                "No API key configured for active LLM providers (AIHOPE_API_KEY / OPENROUTER_API_KEY)",
                503,
            )
        if not any_ok:
            raise ApiError(
                "provider_error",
                "LLM balance request failed for all active providers",
                502,
            )
        return {"ok": True, "trace_id": trace_id, "data": out}

    @app.get("/v1/docs/catalog")
    async def v1_docs_catalog(request: Request, _: None = Depends(dep_viewer)):
        """List markdown docs available under docs/ (and legacy HELP/README)."""
        from core.api.docs_catalog import build_docs_catalog

        trace_id = _trace_id(request)
        return {
            "ok": True,
            "trace_id": trace_id,
            "data": build_docs_catalog(root),
        }

    @app.get("/v1/docs/markdown/{doc_id:path}", response_class=PlainTextResponse)
    async def v1_docs_markdown(doc_id: str, request: Request, _: None = Depends(dep_viewer)):
        from core.api.docs_catalog import resolve_doc_path, sanitize_markdown_text

        trace_id = _trace_id(request)
        target = resolve_doc_path(root, doc_id)
        if target is None:
            raise ApiError("not_found", f"Unknown markdown doc: {doc_id}", 404)
        text = sanitize_markdown_text(target.read_text(encoding="utf-8"), doc_id=doc_id)
        response = PlainTextResponse(content=text)
        response.headers["x-trace-id"] = trace_id
        return response

    def _safe_set(cfg: dict, path: str, value: Any) -> None:
        keys = path.split(".")
        cur = cfg
        for k in keys[:-1]:
            nxt = cur.get(k)
            if not isinstance(nxt, dict):
                nxt = {}
                cur[k] = nxt
            cur = nxt
        cur[keys[-1]] = value

    @app.get("/v1/config/runtime")
    async def v1_config_runtime(request: Request, _: str = Depends(dep_admin)):
        """Allowlisted runtime config snapshot for dashboard Settings (no secrets)."""
        trace_id = _trace_id(request)
        return {
            "ok": True,
            "trace_id": trace_id,
            "data": {
                "values": runtime_config_snapshot(config),
                "providers": configured_llm_providers(config),
            },
        }

    @app.post("/v1/config/update")
    async def v1_config_update(body: ConfigUpdateRequest, request: Request, api_role: str = Depends(dep_admin)):
        """Apply allowlisted keys: persist to layer YAML first, then runtime + LLM rebind."""
        trace_id = _trace_id(request)
        _audit("config_update", trace_id, api_role, {"keys": list(body.updates.keys())})
        updates_applied: dict[str, Any] = {}
        for k, v in body.updates.items():
            if k not in CONFIG_RUNTIME_ALLOWLIST:
                raise ApiError("forbidden_update", f"Path not allowed: {k}", 403)
            updates_applied[k] = v

        # Snapshot for rollback if disk write or LLM rebind fails after partial in-memory apply.
        rollback: dict[str, Any] = {
            k: _config_get_path(config, k) for k in updates_applied
        }

        persisted: list[str] = []
        if updates_applied:
            try:
                from core.runtime.config_loader import persist_allowlisted_updates

                persisted = persist_allowlisted_updates(root, updates_applied)
            except Exception as e:
                logger.exception("Failed to persist runtime config updates")
                raise ApiError("persist_failed", f"Disk write failed (runtime unchanged): {e}", 500) from e

        for k, v in updates_applied.items():
            _safe_set(config, k, v)

        llm_rebound = False
        if any(str(k).startswith("llm.") for k in updates_applied):
            try:
                agent._setup_llm()
                llm_rebound = True
            except Exception as e:
                logger.exception("LLM rebind after config update failed; rolling back memory")
                for k, old in rollback.items():
                    if old is None:
                        # best-effort: set previous missing as empty-ish skip — leave key if newly created
                        continue
                    _safe_set(config, k, old)
                raise ApiError(
                    "llm_rebind_failed",
                    (
                        "Сохранено на диск, но LLM-клиенты не пересобраны "
                        f"(runtime откатан; мягкий рестарт подхватит диск): {e}"
                    ),
                    500,
                ) from e

        if "logging.level" in updates_applied:
            try:
                level_name = str(updates_applied["logging.level"] or "").strip().upper()
                if level_name:
                    logging.getLogger().setLevel(getattr(logging, level_name, logging.INFO))
            except Exception:
                logger.debug("Failed to apply logging.level at runtime", exc_info=True)

        return {
            "ok": True,
            "trace_id": trace_id,
            "data": {
                "updated": updates_applied,
                "persisted": persisted,
                "llm_rebound": llm_rebound,
            },
        }

    @app.post("/v1/backup/run")
    async def v1_backup_run(request: Request, api_role: str = Depends(dep_maint)):
        trace_id = _trace_id(request)
        _audit("backup_run", trace_id, api_role)
        res = await asyncio.to_thread(backup_manager.run_backup, "api_manual")
        return {"ok": True, "trace_id": trace_id, "data": res}

    @app.post("/v1/webhooks/out/routes")
    async def v1_webhooks_route_create(
        body: WebhookRouteCreateRequest,
        request: Request,
        api_role: str = Depends(dep_admin),
    ):
        trace_id = _trace_id(request)
        row = await webhook_store.upsert_route(
            {
                "route_id": body.route_id or "",
                "event_type": body.event_type,
                "target_url": body.target_url,
                "secret": body.secret,
                "enabled": body.enabled,
                "max_retries": body.max_retries,
            }
        )
        _audit(
            "webhook_route_create",
            trace_id,
            api_role,
            {"route_id": row.get("route_id"), "event_type": body.event_type},
        )
        return {"ok": True, "trace_id": trace_id, "data": row}

    @app.get("/v1/webhooks/out/routes")
    async def v1_webhooks_route_list(request: Request, _: None = Depends(dep_admin)):
        trace_id = _trace_id(request)
        rows = await webhook_store.list_routes()
        return {"ok": True, "trace_id": trace_id, "data": {"routes": rows}}

    @app.patch("/v1/webhooks/out/routes/{route_id}")
    async def v1_webhooks_route_patch(
        route_id: str,
        body: WebhookRouteUpdateRequest,
        request: Request,
        _: None = Depends(dep_admin),
    ):
        trace_id = _trace_id(request)
        current = await webhook_store.get_route(route_id)
        if current is None:
            raise ApiError("not_found", f"Route not found: {route_id}", 404)
        source_state = webhook_store._state["routes"].get(route_id, {})
        updates = {k: v for k, v in body.model_dump().items() if v is not None}
        merged = {**source_state, **updates, "route_id": route_id}
        row = await webhook_store.upsert_route(merged)
        return {"ok": True, "trace_id": trace_id, "data": row}

    @app.delete("/v1/webhooks/out/routes/{route_id}")
    async def v1_webhooks_route_delete(route_id: str, request: Request, _: None = Depends(dep_admin)):
        trace_id = _trace_id(request)
        ok = await webhook_store.delete_route(route_id)
        if not ok:
            raise ApiError("not_found", f"Route not found: {route_id}", 404)
        return {"ok": True, "trace_id": trace_id, "data": {"deleted": True, "route_id": route_id}}

    @app.post("/v1/webhooks/out/test/{route_id}")
    async def v1_webhooks_route_test(
        route_id: str,
        body: WebhookTestRequest,
        request: Request,
        _: None = Depends(dep_admin),
    ):
        trace_id = _trace_id(request)
        route = webhook_store._state["routes"].get(route_id)
        if not isinstance(route, dict):
            raise ApiError("not_found", f"Route not found: {route_id}", 404)
        payload = {
            "event_type": route.get("event_type"),
            "source": "manual_test",
            "payload": body.payload,
            "ts": _utc_now(),
        }
        row = await _dispatch_webhook(webhook_store, route, payload, source="manual_test")
        return {"ok": True, "trace_id": trace_id, "data": row}

    @app.get("/v1/webhooks/deliveries")
    async def v1_webhooks_deliveries(
        request: Request,
        status: Optional[str] = Query(default=None),
        _: None = Depends(dep_admin),
    ):
        trace_id = _trace_id(request)
        rows = await webhook_store.list_deliveries((status or "").strip())
        return {"ok": True, "trace_id": trace_id, "data": {"deliveries": rows}}

    @app.post("/v1/webhooks/deliveries/{delivery_id}/retry")
    async def v1_webhooks_delivery_retry(
        delivery_id: str,
        body: WebhookRetryRequest,
        request: Request,
        _: None = Depends(dep_admin),
    ):
        trace_id = _trace_id(request)
        row = await webhook_store.get_delivery(delivery_id)
        if row is None:
            raise ApiError("not_found", f"Delivery not found: {delivery_id}", 404)
        route_id = str(row.get("route_id") or "")
        route = webhook_store._state["routes"].get(route_id)
        if not isinstance(route, dict):
            raise ApiError("not_found", f"Route not found for delivery: {route_id}", 404)
        if body.delay_seconds > 0:
            await asyncio.sleep(body.delay_seconds)
        redelivered = await _dispatch_webhook(
            webhook_store,
            route,
            row.get("payload") or {},
            source="manual_retry",
        )
        return {"ok": True, "trace_id": trace_id, "data": redelivered}

    @app.get("/v1/webhooks/dlq")
    async def v1_webhooks_dlq(request: Request, _: None = Depends(dep_admin)):
        trace_id = _trace_id(request)
        rows = await webhook_store.list_dlq()
        return {"ok": True, "trace_id": trace_id, "data": {"items": rows}}

    async def _handle_inbound_payload(
        provider: str,
        endpoint_id: str,
        payload: dict[str, Any],
        inbound_headers: dict[str, str],
    ) -> dict[str, Any]:
        source = f"webhook.{provider}"
        ev = CoreEvent(
            event_type=f"webhook.{provider}.inbound",
            source=source,
            payload={
                "endpoint_id": endpoint_id,
                "provider": provider,
                "headers": inbound_headers,
                "payload": payload,
                "received_at": _utc_now(),
            },
        )
        agent.event_bus.publish(ev)
        txt = str(
            payload.get("text")
            or payload.get("message")
            or payload.get("content")
            or ""
        ).strip()
        chat_reply = ""
        if txt:
            disp = payload.get("author_display_name") or payload.get("display_name")
            chat_reply = await agent.chat(
                user_message=txt,
                username=str(payload.get("username") or f"{provider}_user"),
                discord_user_id=str(payload.get("user_id") or ""),
                channel_id=str(payload.get("channel_id") or f"{provider}:{endpoint_id}"),
                author_display_name=str(disp).strip() if disp else None,
            )
        return {"accepted": True, "provider": provider, "endpoint_id": endpoint_id, "reply": chat_reply}

    @app.post("/v1/webhooks/in/{provider}/{endpoint_id}")
    async def v1_webhooks_inbound(provider: str, endpoint_id: str, request: Request):
        trace_id = _trace_id(request)
        raw_body = await request.body()
        ia = config.get("api") if isinstance(config.get("api"), dict) else {}
        secret = str(ia.get("webhook_inbound_secret") or "").strip()
        if secret:
            sig = request.headers.get("x-neyra-signature") or request.headers.get("X-Neyra-Signature")
            if not _verify_inbound_webhook_signature(secret, raw_body, sig):
                return JSONResponse(
                    status_code=401,
                    content=_err_payload(trace_id, "invalid_signature", "Invalid or missing X-Neyra-Signature"),
                    headers={"x-trace-id": trace_id},
                )
        payload = _parse_inbound_json_body(raw_body)
        inbound_headers = {k: v for k, v in request.headers.items()}
        out = await _handle_inbound_payload(provider, endpoint_id, payload, inbound_headers)
        return {"ok": True, "trace_id": trace_id, "data": out}

    @app.get("/v1/webhooks/in/{provider}/{endpoint_id}/health")
    async def v1_webhooks_inbound_health(
        provider: str,
        endpoint_id: str,
        request: Request,
        _: None = Depends(dep_viewer),
    ):
        """Requires viewer+ Bearer when API tokens are configured (same as other /v1 reads)."""
        trace_id = _trace_id(request)
        return {
            "ok": True,
            "trace_id": trace_id,
            "data": {"provider": provider, "endpoint_id": endpoint_id, "status": "ready"},
        }

    @app.websocket("/v1/ws/chat")
    async def ws_chat(
        websocket: WebSocket,
        token: Optional[str] = Query(default=None),
    ):
        trace_id = str(uuid.uuid4())
        authorization = websocket.headers.get("authorization")
        try:
            ws_role = _require_ws_auth(token, authorization, config, dash_auth)
            # Same bar as POST /v1/chat (admin): viewer must not mutate memory / spend LLM.
            if not _role_at_least(ws_role, "admin"):
                raise ApiError("forbidden", "WebSocket chat requires admin (same as POST /v1/chat)", 403)
        except ApiError:
            # 1008: Policy Violation
            await websocket.close(code=1008, reason="unauthorized")
            return
        await websocket.accept()
        await websocket.send_json(
            {
                "type": "hello",
                "trace_id": trace_id,
                "protocol": "neyra.ws.chat.v1",
                "role": ws_role,
                "ping_interval_seconds": ws_ping_interval,
                "idle_timeout_seconds": ws_idle_timeout,
                "reconnect": "open_new_socket",
            }
        )
        while True:
            try:
                msg = await asyncio.wait_for(websocket.receive_json(), timeout=ws_idle_timeout)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "error", "code": "idle_timeout", "trace_id": trace_id})
                await asyncio.sleep(ws_close_grace)
                await websocket.close(code=1000, reason="idle timeout")
                break
            except WebSocketDisconnect:
                break
            except Exception:
                await websocket.send_json({"type": "error", "code": "bad_payload", "trace_id": trace_id})
                continue

            kind = str(msg.get("type") or "").strip().lower()
            if kind == "ping":
                await websocket.send_json({"type": "pong", "ts": datetime.now().isoformat(), "trace_id": trace_id})
                continue
            if kind != "chat":
                await websocket.send_json({"type": "error", "code": "unknown_type", "trace_id": trace_id})
                continue

            text = str(msg.get("text") or "").strip()
            if not text:
                await websocket.send_json({"type": "error", "code": "empty_text", "trace_id": trace_id})
                continue
            username = str(msg.get("username") or "ws_user")
            platform_user_id = str(msg.get("platform_user_id") or "")
            channel_id = str(msg.get("channel_id") or "ws")
            ws_disp = msg.get("author_display_name") or msg.get("display_name")
            ws_author_disp = str(ws_disp).strip() if ws_disp else None

            try:
                async for chunk in agent.chat_stream(
                    text,
                    username=username,
                    discord_user_id=platform_user_id,
                    channel_id=channel_id,
                    author_display_name=ws_author_disp,
                ):
                    if chunk.get("type") == "token":
                        await websocket.send_json(
                            {"type": "token", "text": chunk.get("text", ""), "trace_id": trace_id}
                        )
                    elif chunk.get("type") == "done":
                        await websocket.send_json(
                            {
                                "type": "done",
                                "text": chunk.get("text", ""),
                                "sounds": chunk.get("sounds", []),
                                "trace_id": trace_id,
                            }
                        )
                    elif chunk.get("type") == "error":
                        await websocket.send_json(
                            {"type": "error", "code": "chat_error", "message": chunk.get("text", ""), "trace_id": trace_id}
                        )
            except WebSocketDisconnect:
                break
            except Exception as e:
                await websocket.send_json({"type": "error", "code": "internal_chat_error", "message": str(e), "trace_id": trace_id})

    @app.websocket("/v1/ws/audio")
    async def ws_audio(
        websocket: WebSocket,
        token: Optional[str] = Query(default=None),
    ):
        """
        Minimal bidirectional audio stream endpoint.
        Accepts binary audio chunks and emits lightweight interim/final events.
        (STT provider adapters are handled in 5.2; here is the gateway contract.)
        """
        trace_id = str(uuid.uuid4())
        authorization = websocket.headers.get("authorization")
        try:
            ws_role = _require_ws_auth(token, authorization, config, dash_auth)
            if not _role_at_least(ws_role, "viewer"):
                raise ApiError("forbidden", "WebSocket audio requires viewer+", 403)
        except ApiError:
            await websocket.close(code=1008, reason="unauthorized")
            return
        await websocket.accept()
        await websocket.send_json(
            {
                "type": "hello",
                "trace_id": trace_id,
                "protocol": "neyra.ws.audio.v1",
                "role": ws_role,
                "ping_interval_seconds": ws_ping_interval,
                "idle_timeout_seconds": ws_idle_timeout,
            }
        )
        chunk_count = 0
        bytes_total = 0
        while True:
            try:
                packet = await asyncio.wait_for(websocket.receive(), timeout=ws_idle_timeout)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "error", "code": "idle_timeout", "trace_id": trace_id})
                await asyncio.sleep(ws_close_grace)
                await websocket.close(code=1000, reason="idle timeout")
                break
            except WebSocketDisconnect:
                break

            if packet.get("type") == "websocket.disconnect":
                break

            text_data = packet.get("text")
            if text_data:
                try:
                    msg = json.loads(text_data)
                except Exception:
                    msg = {}
                kind = str(msg.get("type") or "").strip().lower()
                if kind == "ping":
                    await websocket.send_json({"type": "pong", "ts": datetime.now().isoformat(), "trace_id": trace_id})
                    continue
                if kind == "commit":
                    await websocket.send_json(
                        {
                            "type": "transcript.final",
                            "text": f"[stub] received {chunk_count} chunks / {bytes_total} bytes",
                            "trace_id": trace_id,
                        }
                    )
                    chunk_count = 0
                    bytes_total = 0
                    continue
                await websocket.send_json({"type": "error", "code": "unknown_type", "trace_id": trace_id})
                continue

            data = packet.get("bytes")
            if data:
                chunk_count += 1
                bytes_total += len(data)
                # Lightweight interim event to keep stream alive.
                if chunk_count % 5 == 0:
                    await websocket.send_json(
                        {
                            "type": "transcript.interim",
                            "text": f"[stub] audio chunks: {chunk_count}",
                            "trace_id": trace_id,
                        }
                    )

    dash_cfg = config.get("dashboard") or {}
    if bool(dash_cfg.get("enabled", True)):
        dist = _dashboard_dist_path(config)
        index = dist / "index.html"
        if dist.is_dir() and index.is_file():
            assets_dir = dist / "assets"
            if assets_dir.is_dir():
                app.mount("/assets", StaticFiles(directory=str(assets_dir)), name="neyra_assets")

            dist_resolved = dist.resolve()

            def _spa_index() -> FileResponse:
                return FileResponse(index)

            @app.get("/")
            async def spa_root():
                return _spa_index()

            @app.get("/{full_path:path}")
            async def spa_fallback(full_path: str):
                """Serve SPA index for client routes (/dashboard, /plugins, …)."""
                low = (full_path or "").lstrip("/").lower()
                if (
                    low == "v1"
                    or low.startswith("v1/")
                    or low in ("docs", "redoc", "openapi.json")
                    or low.startswith(("docs/", "redoc/"))
                ):
                    return JSONResponse(status_code=404, content={"detail": "Not Found"})

                candidate = (dist / full_path).resolve()
                try:
                    candidate.relative_to(dist_resolved)
                except ValueError:
                    return JSONResponse(status_code=404, content={"detail": "Not Found"})
                if candidate.is_file():
                    return FileResponse(candidate)
                return _spa_index()

            logger.info("Serving dashboard SPA from %s (assets + index fallback)", dist)
        else:
            logger.warning(
                "Dashboard enabled but no build at %s — only API (run: cd dashboard && npm install && npm run build).",
                dist,
            )

    return app
