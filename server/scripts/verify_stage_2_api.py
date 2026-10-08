#!/usr/bin/env python3
"""Stage 2: core API package, api: config, auth matrix (offline)."""

from __future__ import annotations

import json
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

SERVER_ROOT = Path(__file__).resolve().parent.parent
if str(SERVER_ROOT) not in sys.path:
    sys.path.insert(0, str(SERVER_ROOT))


def check_package_layout() -> list[str]:
    errs: list[str] = []
    api_dir = SERVER_ROOT / "core" / "api"
    if not (api_dir / "app.py").is_file():
        errs.append("missing core/api/app.py")
    if not (api_dir / "__init__.py").is_file():
        errs.append("missing core/api/__init__.py")
    legacy = SERVER_ROOT / "modules" / "internal_api"
    if legacy.exists():
        errs.append("modules/internal_api must be removed (API is core)")
    return errs


def check_public_url_helper() -> list[str]:
    from core.api import api_public_root, api_public_v1, site_public_origin, API_VERSION

    errs: list[str] = []
    cfg = {
        "api": {
            "public_base_url": "https://neyra.owyx.site",
            "public_path_prefix": "/api",
            "host": "127.0.0.1",
            "port": 8787,
        }
    }
    if api_public_root(cfg) != "https://neyra.owyx.site/api":
        errs.append(f"public root bad: {api_public_root(cfg)!r}")
    if api_public_v1(cfg) != "https://neyra.owyx.site/api/v1":
        errs.append(f"public v1 bad: {api_public_v1(cfg)!r}")
    if site_public_origin(cfg) != "https://neyra.owyx.site":
        errs.append(f"site origin bad: {site_public_origin(cfg)!r}")
    if not API_VERSION:
        errs.append("API_VERSION empty")
    empty = api_public_root({"api": {}})
    if empty != "":
        errs.append(f"empty public_base_url should yield '', got {empty!r}")
    return errs


def _load_example_layers() -> dict[str, Any]:
    """Load only tracked *.example.yaml into a temp tree (CI-safe, no local config/*.yaml)."""
    from core.runtime.config_loader import LAYER_FILES, load_layered_yaml

    tmp = Path(tempfile.mkdtemp(prefix="neyra_s2_"))
    try:
        shutil.copy2(SERVER_ROOT / "config.example.yaml", tmp / "config.yaml")
        cfg_dir = tmp / "config"
        cfg_dir.mkdir(parents=True, exist_ok=True)
        for name in LAYER_FILES:
            stem = name.replace(".yaml", "")
            src = SERVER_ROOT / "config" / f"{stem}.example.yaml"
            if src.is_file():
                shutil.copy2(src, cfg_dir / name)
        return load_layered_yaml(tmp)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def check_config_key_api() -> list[str]:
    from core.runtime.config_loader import validate_config_schema

    errs: list[str] = []
    cfg = _load_example_layers()
    if "internal_api" in cfg:
        errs.append("layered cfg still has internal_api")
    api = cfg.get("api")
    if not isinstance(api, dict):
        errs.append("api: section missing from example layers")
    else:
        if "host" not in api or "port" not in api:
            errs.append("api.host/port missing")
        if "public_base_url" not in api:
            errs.append("api.public_base_url missing from example layer")
        if str(api.get("public_base_url") or "").strip():
            errs.append("example public_base_url should be empty by default")
    dash = cfg.get("dashboard")
    if not isinstance(dash, dict):
        errs.append("dashboard: section missing from example layers")
    elif "public_base_url" in dash:
        errs.append("dashboard.public_base_url must not exist — use api.public_base_url only")
    bad = {
        "paths": {"data_dir": "./data"},
        "assistant": {"name": "X"},
        "memory": {},
        "logging": {"level": "INFO", "system_log": "x"},
        "llm": {"talk_model": {"provider": "openrouter", "model": "x"}},
        "internal_api": {"host": "127.0.0.1"},
    }
    schema = validate_config_schema(bad)
    if not any("internal_api" in e for e in schema):
        errs.append(f"schema must reject internal_api, got {schema}")
    return errs


def check_build_app_routes() -> list[str]:
    errs: list[str] = []
    text = (SERVER_ROOT / "core" / "api" / "app.py").read_text(encoding="utf-8")
    for need in (
        '@app.get("/v1/meta")',
        '@app.get("/v1/llm/models")',
        '@app.get("/v1/health")',
        '@app.post("/v1/system/restart")',
        '@app.websocket("/v1/ws/chat")',
        '@app.post("/v1/plugins/upload")',
        '@app.get("/v1/logs")',
        '@app.get("/v1/webhooks/event-types")',
    ):
        if need not in text:
            errs.append(f"missing route decorator {need}")
    if "reload_plugin" not in text and "restart_scheduled" not in text:
        errs.append("plugin reload/restart should call reload_plugin or schedule soft-restart")
    if "X-Neyra-Signature" not in text and "x-neyra-signature" not in text.lower():
        errs.append("outbound webhooks should sign with X-Neyra-Signature")
    if "hmac.compare_digest" not in text and "_token_eq" not in text:
        errs.append("token compare should use constant-time helper")
    return errs


def check_no_legacy_imports() -> list[str]:
    errs: list[str] = []
    hits: list[str] = []
    for path in (SERVER_ROOT / "core").rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        if "modules.internal_api" in text or "modules/internal_api" in text:
            hits.append(str(path.relative_to(SERVER_ROOT)))
    if hits:
        errs.append("core still references modules.internal_api: " + ", ".join(hits[:10]))
    return errs


def check_bind_gate() -> list[str]:
    from core.api import assert_api_bind_safe

    errs: list[str] = []
    try:
        assert_api_bind_safe({"api": {"host": "0.0.0.0"}})
        errs.append("expected refuse 0.0.0.0 without tokens")
    except RuntimeError:
        pass
    try:
        assert_api_bind_safe({"api": {"host": "127.0.0.1"}})
    except Exception as e:
        errs.append(f"loopback without tokens should be ok: {e}")
    try:
        assert_api_bind_safe({"api": {"host": "0.0.0.0", "token": "x"}})
    except Exception as e:
        errs.append(f"non-loopback with token should be ok: {e}")
    return errs


def check_auth_matrix() -> list[str]:
    """Behavioral auth checks via TestClient (no real LLM/memory)."""
    import tempfile
    from fastapi.testclient import TestClient

    from core.api import build_app
    import core.api.app as api_mod

    errs: list[str] = []
    data_tmp = Path(tempfile.mkdtemp(prefix="neyra_api_test_"))

    from core.runtime.event_bus import EventBus

    agent = MagicMock()
    agent.chat = AsyncMock(return_value={"reply": "ok"})
    agent.chat_stream = AsyncMock()
    agent.start_mcp_clients = AsyncMock()
    agent.stop_mcp_clients = AsyncMock()
    agent.memory_hub = None
    agent.long_memory = MagicMock(count=MagicMock(return_value=0))
    agent.event_bus = EventBus()

    monitor = MagicMock()
    monitor.start = MagicMock()
    monitor.run_once = AsyncMock(return_value={"status": "ok"})

    backup = MagicMock()

    cfg = {
        "paths": {"data_dir": str(data_tmp)},
        "api": {
            "host": "127.0.0.1",
            "port": 8787,
            "token": "admin-secret",
            "viewer_token": "viewer-secret",
            "maint_token": "maint-secret",
            "public_base_url": "",
            "public_path_prefix": "/api",
            "audit_log_enabled": False,
            "rate_limit_requests_per_minute": 0,
            "websocket": {
                "idle_timeout_seconds": 5,
                "ping_interval_seconds": 20,
                "close_grace_seconds": 1,
            },
        },
        "dashboard": {"enabled": False},
        "llm": {
            "talk_model": {"provider": "openrouter", "model": "x"},
            "brain_model": {"provider": "openrouter", "model": "x"},
            "memory_model": {"provider": "openrouter", "model": "x"},
            "vision_model": {"provider": "openrouter", "model": "x"},
            "providers": {"openrouter": {"model": "x"}},
        },
    }

    app = build_app(
        cfg,
        shared_agent=agent,
        shared_monitor=monitor,
        shared_backup_manager=backup,
    )

    scheduled: list[str] = []

    def _fake_exit(reason: str = "system_restart") -> None:
        scheduled.append(reason)

    orig_exit = api_mod._schedule_exit_after_response
    api_mod._schedule_exit_after_response = _fake_exit  # type: ignore[assignment]
    try:
        # Peer 127.0.0.1 so setup-guard sees console-local when no CF/X-Real headers.
        with TestClient(app, client=("127.0.0.1", 50000)) as client:
            r = client.get("/v1/dashboard/auth/status")
            if r.status_code != 200:
                errs.append(f"dash auth status want 200, got {r.status_code}")
            else:
                data = (r.json().get("data") or {})
                if data.get("configured") is not False:
                    errs.append(f"fresh app dash auth should be unconfigured: {data}")

            DASH_KEY = "dash-key-1234-xxxxxxxxxxxxxxxxxxxxxx"  # >= 32
            DASH_KEY_OTHER = "other-key-9999-xxxxxxxxxxxxxxxxxxxxx"
            DASH_KEY_WRONG = "wrong-key-0000-xxxxxxxxxxxxxxxxxxxxx"

            # Setup-guard: any CF/X-Real (incl. forged loopback) without primary Bearer → 403
            r = client.post(
                "/v1/dashboard/auth/setup",
                json={"key": DASH_KEY},
                headers={"CF-Connecting-IP": "203.0.113.9"},
            )
            if r.status_code != 403:
                errs.append(
                    f"setup with CF public IP (no Bearer) want 403, got {r.status_code} {r.text[:120]}"
                )
            r = client.post(
                "/v1/dashboard/auth/setup",
                json={"key": DASH_KEY},
                headers={"CF-Connecting-IP": "127.0.0.1"},
            )
            if r.status_code != 403:
                errs.append(
                    f"setup with forged CF loopback (no Bearer) want 403, got {r.status_code} {r.text[:120]}"
                )
            r = client.post(
                "/v1/dashboard/auth/setup",
                json={"key": DASH_KEY},
                headers={
                    "CF-Connecting-IP": "203.0.113.9",
                    "Authorization": "Bearer viewer-secret",
                },
            )
            if r.status_code != 403:
                errs.append(
                    f"setup with CF public IP + viewer Bearer want 403, got {r.status_code} {r.text[:120]}"
                )
            r = client.post("/v1/dashboard/auth/setup", json={"key": DASH_KEY})
            if r.status_code != 200:
                errs.append(
                    f"setup from loopback without CF want 200, got {r.status_code} {r.text[:120]}"
                )
            else:
                sess = (r.json().get("data") or {}).get("session_token")
                if not sess:
                    errs.append("loopback setup must return session_token")

            # Already configured → second setup with Bearer must be 409
            r = client.post(
                "/v1/dashboard/auth/setup",
                json={"key": DASH_KEY_OTHER},
                headers={"Authorization": "Bearer admin-secret"},
            )
            if r.status_code != 409:
                errs.append(f"second setup want 409, got {r.status_code}")
            r = client.post("/v1/dashboard/auth/login", json={"key": DASH_KEY_WRONG})
            if r.status_code != 401:
                errs.append(f"bad dash login want 401, got {r.status_code}")
            r = client.post("/v1/dashboard/auth/login", json={"key": DASH_KEY})
            if r.status_code != 200:
                errs.append(f"good dash login want 200, got {r.status_code}")
            else:
                sess = (r.json().get("data") or {}).get("session_token")
                if not sess:
                    errs.append("dash auth login must return session_token")
                else:
                    r = client.get("/v1/health", headers={"Authorization": f"Bearer {sess}"})
                    if r.status_code != 200:
                        errs.append(f"session Bearer health want 200, got {r.status_code}")
                    r = client.post(
                        "/v1/dashboard/auth/logout",
                        headers={"Authorization": f"Bearer {sess}"},
                    )
                    if r.status_code != 200:
                        errs.append(f"dash logout want 200, got {r.status_code}")
                    r = client.get("/v1/health", headers={"Authorization": f"Bearer {sess}"})
                    if r.status_code != 401:
                        errs.append(f"revoked session health want 401, got {r.status_code}")

            r = client.get("/v1/health")
            if r.status_code != 401:
                errs.append(f"no token → health want 401, got {r.status_code}")

            r = client.get("/v1/health", headers={"Authorization": "Bearer viewer-secret"})
            if r.status_code != 200:
                errs.append(f"viewer health want 200, got {r.status_code}")

            r = client.get("/v1/meta", headers={"Authorization": "Bearer viewer-secret"})
            if r.status_code != 200:
                errs.append(f"viewer meta want 200, got {r.status_code}")
            else:
                data = (r.json().get("data") or {})
                if "bind" in data:
                    errs.append("meta must not expose bind")
                if data.get("api_version") != api_mod.API_VERSION:
                    errs.append("meta api_version mismatch")

            r = client.post(
                "/v1/system/restart",
                headers={"Authorization": "Bearer viewer-secret"},
            )
            if r.status_code != 403:
                errs.append(f"viewer restart want 403, got {r.status_code}")

            r = client.post(
                "/v1/system/restart",
                headers={"Authorization": "Bearer maint-secret"},
            )
            if r.status_code != 200:
                errs.append(f"maint restart want 200, got {r.status_code}")
            elif not scheduled:
                errs.append("maint restart did not schedule exit")

            # Resident toggle must schedule soft restart — use a throwaway fake plugin
            # (never touch live discord/Lavalink or tracked plugin.yaml).
            fake_id = "_ar_fake_resident"
            fake_dir = SERVER_ROOT / "modules" / fake_id
            fake_yaml = fake_dir / "plugin.yaml"
            # Clean leftover from a killed prior run (AR-15).
            if fake_dir.exists():
                shutil.rmtree(fake_dir, ignore_errors=True)
            try:
                fake_dir.mkdir(parents=True, exist_ok=True)
                fake_yaml.write_text(
                    "\n".join(
                        [
                            f"id: {fake_id}",
                            "name: AR fake resident",
                            "description: ephemeral verify fixture",
                            'version: "0.0.0"',
                            "enabled: true",
                            "lifecycle: resident",
                            "cli_modes: []",
                            "main_script: main.py",
                            "",
                        ]
                    ),
                    encoding="utf-8",
                )
                (fake_dir / "main.py").write_text("# ar fixture\n", encoding="utf-8")
                scheduled.clear()
                r = client.patch(
                    f"/v1/plugins/{fake_id}",
                    json={"enabled": False},
                    headers={"Authorization": "Bearer admin-secret"},
                )
                if r.status_code != 200:
                    errs.append(f"resident toggle want 200, got {r.status_code} {r.text[:160]}")
                else:
                    result = ((r.json().get("data") or {}).get("result") or {})
                    if result.get("restart_scheduled") is not True:
                        errs.append(f"resident toggle must set restart_scheduled: {result}")
                    if result.get("enabled_changed") is not True:
                        errs.append(f"resident toggle must set enabled_changed: {result}")
                    if not any(str(x).startswith("resident_plugin_toggle:") for x in scheduled):
                        errs.append(f"resident toggle did not schedule exit: {scheduled}")
                # Idempotent PATCH must not bounce the core again.
                scheduled.clear()
                r = client.patch(
                    f"/v1/plugins/{fake_id}",
                    json={"enabled": False},
                    headers={"Authorization": "Bearer admin-secret"},
                )
                if r.status_code != 200:
                    errs.append(f"idempotent resident toggle want 200, got {r.status_code}")
                else:
                    result = ((r.json().get("data") or {}).get("result") or {})
                    if result.get("restart_scheduled") is not False:
                        errs.append(f"noop resident toggle must not schedule restart: {result}")
                    if result.get("enabled_changed") is not False:
                        errs.append(f"noop resident toggle must set enabled_changed false: {result}")
                    if scheduled:
                        errs.append(f"noop resident toggle scheduled exit: {scheduled}")
            except Exception as e:
                errs.append(f"resident toggle fixture failed: {e}")
            finally:
                scheduled.clear()
                try:
                    if fake_dir.exists():
                        shutil.rmtree(fake_dir, ignore_errors=True)
                except Exception:
                    pass

            r = client.post(
                "/v1/plugins/nope/reload",
                headers={"Authorization": "Bearer admin-secret"},
            )
            if r.status_code not in (404, 501):
                errs.append(f"plugin reload want 404/501, got {r.status_code}")

            viewer_ws_ok = False
            try:
                with client.websocket_connect(
                    "/v1/ws/chat",
                    headers={"Authorization": "Bearer viewer-secret"},
                ) as ws:
                    msg = ws.receive_json()
                    if msg.get("type") == "hello":
                        errs.append("viewer must not get ws chat hello")
                    viewer_ws_ok = True
            except Exception:
                # Rejected / closed before hello — expected for viewer.
                viewer_ws_ok = False
            if viewer_ws_ok and not errs:
                pass  # hello already flagged

            with client.websocket_connect(
                "/v1/ws/chat",
                headers={"Authorization": "Bearer admin-secret"},
            ) as ws:
                hello = ws.receive_json()
                if hello.get("type") != "hello":
                    errs.append(f"admin ws hello missing: {hello}")
                elif hello.get("role") != "admin":
                    errs.append(f"admin ws role bad: {hello.get('role')}")
                elif hello.get("reconnect") != "open_new_socket":
                    errs.append("ws hello missing reconnect hint")
    finally:
        api_mod._schedule_exit_after_response = orig_exit  # type: ignore[assignment]

    return errs


def check_legacy_env_failfast() -> list[str]:
    import os

    from core.runtime.secrets import apply_env_secrets

    errs: list[str] = []
    key = "INTERNAL_API_TOKEN"
    prev = os.environ.get(key)
    os.environ[key] = "legacy-should-fail"
    try:
        try:
            apply_env_secrets({})
            errs.append("INTERNAL_API_TOKEN should raise RuntimeError")
        except RuntimeError as e:
            if "API_TOKEN" not in str(e):
                errs.append(f"fail-fast message unclear: {e}")
    finally:
        if prev is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = prev
    return errs


def check_api_key_alias() -> list[str]:
    import os

    from core.runtime.secrets import apply_env_secrets

    errs: list[str] = []
    prev_t = os.environ.get("API_TOKEN")
    prev_k = os.environ.get("API_KEY")
    os.environ.pop("API_TOKEN", None)
    os.environ["API_KEY"] = "alias-admin-token-0123456789abcdef"
    try:
        cfg: dict = {}
        apply_env_secrets(cfg)
        tok = ((cfg.get("api") or {}).get("token") or "")
        if tok != "alias-admin-token-0123456789abcdef":
            errs.append(f"API_KEY should map to api.token, got {tok!r}")
    finally:
        if prev_t is None:
            os.environ.pop("API_TOKEN", None)
        else:
            os.environ["API_TOKEN"] = prev_t
        if prev_k is None:
            os.environ.pop("API_KEY", None)
        else:
            os.environ["API_KEY"] = prev_k
    return errs


def check_dashboard_gate_store() -> list[str]:
    import tempfile
    from pathlib import Path

    from core.api.dashboard_auth import MIN_KEY_LEN, DashboardAuthStore

    errs: list[str] = []
    tmp = Path(tempfile.mkdtemp(prefix="neyra_dash_auth_")) / "gate.sqlite"
    store = DashboardAuthStore(tmp)
    if store.is_configured():
        errs.append("fresh store should be unconfigured")
    try:
        store.setup("ab")
        errs.append("short key should fail")
    except ValueError:
        pass
    try:
        store.setup("x" * (MIN_KEY_LEN - 1))
        errs.append(f"{MIN_KEY_LEN - 1}-char key should fail (min {MIN_KEY_LEN})")
    except ValueError:
        pass
    good = "my-secret-key-" + ("x" * 20)  # >= 32
    store.setup(good)
    if not store.is_configured():
        errs.append("after setup should be configured")
    if not store.verify(good):
        errs.append("correct key should verify")
    if store.verify("wrong-key"):
        errs.append("wrong key must not verify")
    try:
        store.setup("another-longer-key-xxxxxxxxxxxxxxxx")
        errs.append("second setup should fail")
    except RuntimeError:
        pass
    sess = store.issue_session()
    if not store.verify_session(sess):
        errs.append("issued session should verify")
    store.revoke_session(sess)
    if store.verify_session(sess):
        errs.append("revoked session must not verify")
    if store.verify_session(good):
        errs.append("raw gate key must not verify as session")
    return errs


def check_spa_routes() -> list[str]:
    """Client routes must return index.html (not FastAPI JSON 404)."""
    import tempfile
    from fastapi.testclient import TestClient

    from core.api import build_app

    errs: list[str] = []
    data_tmp = Path(tempfile.mkdtemp(prefix="neyra_spa_test_"))
    dist = data_tmp / "dashboard" / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>neyra</title>", encoding="utf-8")
    (dist / "favicon.svg").write_text("<svg></svg>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")

    agent = MagicMock()
    agent.start_mcp_clients = AsyncMock()
    agent.stop_mcp_clients = AsyncMock()
    agent.memory_hub = None
    monitor = MagicMock()
    monitor.start = MagicMock()
    monitor.run_once = AsyncMock(return_value={"ok": True})
    backup = MagicMock()

    cfg = {
        "paths": {"data_dir": str(data_tmp / "data")},
        "api": {
            "host": "127.0.0.1",
            "port": 8787,
            "token": "admin-secret",
            "viewer_token": "",
            "maint_token": "",
            "public_base_url": "",
            "public_path_prefix": "/api",
            "audit_log_enabled": False,
            "rate_limit_requests_per_minute": 0,
        },
        "dashboard": {"enabled": True, "dist_path": str(dist)},
        "llm": {},
    }
    app = build_app(
        cfg,
        shared_agent=agent,
        shared_monitor=monitor,
        shared_backup_manager=backup,
    )
    with TestClient(app) as client:
        for path in ("/", "/status", "/modules", "/memory", "/system", "/settings", "/dashboard", "/plugins"):
            r = client.get(path)
            if r.status_code != 200:
                errs.append(f"{path} want 200, got {r.status_code}")
            elif "neyra" not in r.text.lower() and "<!doctype html>" not in r.text.lower():
                errs.append(f"{path} should serve SPA index.html, got: {r.text[:80]!r}")
        r = client.get("/favicon.svg")
        if r.status_code != 200:
            errs.append(f"favicon.svg want 200, got {r.status_code}")
        r = client.get("/assets/app.js")
        if r.status_code != 200:
            errs.append(f"/assets/app.js want 200, got {r.status_code}")
        r = client.get("/v1/no-such-endpoint")
        if r.status_code != 404:
            errs.append(f"/v1/no-such-endpoint want 404, got {r.status_code}")
    return errs


def check_public_url_env_rejected() -> list[str]:
    import os

    from core.runtime.secrets import apply_env_secrets

    errs: list[str] = []
    key = "API_PUBLIC_BASE_URL"
    prev = os.environ.get(key)
    os.environ[key] = "https://should-fail.example"
    try:
        try:
            apply_env_secrets({})
            errs.append("API_PUBLIC_BASE_URL must raise (yaml-only public URL)")
        except RuntimeError as e:
            if "server.yaml" not in str(e) and "public_base_url" not in str(e):
                errs.append(f"public URL fail-fast message unclear: {e}")
    finally:
        if prev is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = prev
    return errs


def check_rate_limit_xff_bucket() -> list[str]:
    """HTTP RPM must key on resolve_client_ip — X-Forwarded-For alone must not rotate buckets."""
    import tempfile
    from unittest.mock import AsyncMock, MagicMock

    from fastapi.testclient import TestClient

    from core.api import build_app
    import core.api.app as api_mod

    errs: list[str] = []
    data_tmp = Path(tempfile.mkdtemp(prefix="neyra_rpm_"))
    agent = MagicMock()
    agent.start_mcp_clients = AsyncMock()
    agent.stop_mcp_clients = AsyncMock()
    agent.memory_hub = None
    monitor = MagicMock()
    monitor.start = MagicMock()
    monitor.run_once = AsyncMock(return_value={"status": "ok"})
    backup = MagicMock()
    cfg = {
        "paths": {"data_dir": str(data_tmp)},
        "api": {
            "host": "127.0.0.1",
            "port": 8787,
            "token": "admin-secret",
            "viewer_token": "viewer-secret",
            "maint_token": "",
            "public_base_url": "",
            "public_path_prefix": "/api",
            "audit_log_enabled": False,
            "rate_limit_requests_per_minute": 3,
            "websocket": {
                "idle_timeout_seconds": 5,
                "ping_interval_seconds": 20,
                "close_grace_seconds": 1,
            },
        },
        "dashboard": {"enabled": False},
        "llm": {},
    }
    app = build_app(
        cfg,
        shared_agent=agent,
        shared_monitor=monitor,
        shared_backup_manager=backup,
    )
    api_mod._rate_limit_buckets.clear()
    with TestClient(app, client=("127.0.0.1", 50000)) as client:
        codes: list[int] = []
        for i in range(5):
            r = client.get(
                "/v1/health",
                headers={
                    "Authorization": "Bearer viewer-secret",
                    "X-Forwarded-For": f"203.0.113.{i}",
                },
            )
            codes.append(r.status_code)
        # Same peer, rotating XFF → same bucket → later calls 429
        if codes.count(429) < 2:
            errs.append(f"rotating XFF should share RPM bucket, codes={codes}")
        # Without XFF, same peer still limited (same bucket)
        r = client.get("/v1/health", headers={"Authorization": "Bearer viewer-secret"})
        if r.status_code != 429:
            errs.append(f"same peer without XFF should still be limited, got {r.status_code}")
    return errs


def check_merge_proposals_api() -> list[str]:
    """HTTP apply/reject/stale/undo for merge proposals (real MemoryHub, no LLM)."""
    import tempfile
    from fastapi.testclient import TestClient

    from core.api import build_app
    from core.memory.hub import MemoryHub

    errs: list[str] = []
    data_tmp = Path(tempfile.mkdtemp(prefix="neyra_merge_api_"))
    db = data_tmp / "hub.db"
    hub = MemoryHub({"memory": {"sqlite_path": str(db), "rag_enabled": False}}, long_memory=None)
    a = hub.ensure_person_for_account(
        platform="discord", platform_user_id="1", handle="n1", display_name="A"
    )
    b = hub.ensure_person_for_account(
        platform="telegram", platform_user_id="2", handle="n1", display_name="B"
    )
    prop = hub.propose_people_merge(a["id"], b["id"], reason="api_test")

    agent = MagicMock()
    agent.chat = AsyncMock(return_value={"reply": "ok"})
    agent.chat_stream = AsyncMock()
    agent.start_mcp_clients = AsyncMock()
    agent.stop_mcp_clients = AsyncMock()
    agent.memory_hub = hub
    agent.people_db = None
    agent.long_memory = MagicMock(count=MagicMock(return_value=0))
    agent.short_memory = MagicMock(clear=MagicMock())

    cfg = {
        "paths": {"data_dir": str(data_tmp)},
        "api": {
            "host": "127.0.0.1",
            "port": 8787,
            "token": "admin-secret",
            "viewer_token": "viewer-secret",
            "maint_token": "maint-secret",
            "public_base_url": "",
            "audit_log_enabled": False,
            "rate_limit_requests_per_minute": 0,
        },
        "dashboard": {"enabled": False},
        "llm": {
            "talk_model": {"provider": "openrouter", "model": "x"},
            "brain_model": {"provider": "openrouter", "model": "x"},
            "memory_model": {"provider": "openrouter", "model": "x"},
            "vision_model": {"provider": "openrouter", "model": "x"},
            "providers": {"openrouter": {"model": "x"}},
        },
    }
    app = build_app(
        cfg,
        shared_agent=agent,
        shared_monitor=MagicMock(start=MagicMock(), run_once=AsyncMock(return_value={})),
        shared_backup_manager=MagicMock(),
    )
    headers = {"Authorization": "Bearer admin-secret"}
    mid = None
    try:
        with TestClient(app) as client:
            pid = int(prop["proposal_id"])
            r = client.post(f"/v1/memory/people/merge-proposals/{pid}/apply", headers=headers)
            if r.status_code != 200:
                errs.append(f"apply want 200, got {r.status_code} {r.text[:200]}")
            else:
                mid = ((r.json().get("data") or {}).get("merge") or {}).get("merge_log_id")
                if not mid:
                    errs.append("apply missing merge_log_id")
                row = hub.sqlite.get_merge_proposal(pid)
                if not row or row.get("status") != "applied":
                    errs.append(f"proposal not applied: {row}")

            r2 = client.post(f"/v1/memory/people/merge-proposals/{pid}/apply", headers=headers)
            if r2.status_code != 409:
                errs.append(f"re-apply want 409, got {r2.status_code}")
            elif "proposal_not_pending" not in json.dumps(r2.json()):
                errs.append(f"re-apply body missing proposal_not_pending: {r2.json()}")

            r404 = client.post("/v1/memory/people/merge-proposals/999999/apply", headers=headers)
            if r404.status_code != 404:
                errs.append(f"missing apply want 404, got {r404.status_code}")
            elif "proposal_not_found" not in json.dumps(r404.json()):
                errs.append(f"missing apply body: {r404.json()}")

            if mid:
                r_undo = client.post(
                    f"/v1/memory/people/merge/{int(mid)}/undo", headers=headers
                )
                if r_undo.status_code != 200:
                    errs.append(f"undo want 200, got {r_undo.status_code}")
                else:
                    undone = hub.sqlite.get_merge_proposal(pid)
                    if not undone or undone.get("status") != "undone":
                        errs.append(f"proposal not undone after undo: {undone}")
                r_undo2 = client.post(
                    f"/v1/memory/people/merge/{int(mid)}/undo", headers=headers
                )
                if r_undo2.status_code != 409:
                    errs.append(f"second undo want 409, got {r_undo2.status_code}")

            # reject
            c = hub.ensure_person_for_account(
                platform="discord", platform_user_id="9", handle="cx", display_name="C"
            )
            rej = hub.propose_people_merge(a["id"], c["id"], reason="rej")
            rid = int(rej["proposal_id"])
            rr = client.post(f"/v1/memory/people/merge-proposals/{rid}/reject", headers=headers)
            if rr.status_code != 200:
                errs.append(f"reject want 200, got {rr.status_code}")
            row_r = hub.sqlite.get_merge_proposal(rid)
            if not row_r or row_r.get("status") != "rejected":
                errs.append(f"reject status: {row_r}")

            # stale: delete person then apply
            d = hub.ensure_person_for_account(
                platform="discord", platform_user_id="8", handle="dx", display_name="D"
            )
            st = hub.propose_people_merge(a["id"], d["id"], reason="stale")
            hub.delete_person(d["id"])
            rs = client.post(
                f"/v1/memory/people/merge-proposals/{int(st['proposal_id'])}/apply",
                headers=headers,
            )
            if rs.status_code != 409:
                errs.append(f"stale apply want 409, got {rs.status_code}")
            elif "proposal_stale" not in json.dumps(rs.json()):
                errs.append(f"stale apply missing proposal_stale: {rs.json()}")
            st_row = hub.sqlite.get_merge_proposal(int(st["proposal_id"]))
            if not st_row or st_row.get("status") != "stale":
                errs.append(f"stale status: {st_row}")
    finally:
        hub.sqlite.close()
    return errs


def check_plugin_ops_and_webhooks() -> list[str]:
    """Upload/files jail, roles, webhook bus bridge, secret copy (AR-8…14)."""
    import asyncio
    import io
    import time
    import zipfile
    from unittest.mock import patch

    import yaml
    from fastapi.testclient import TestClient

    import core.plugins.ops as ops
    from core.api import build_app
    from core.runtime.event_bus import CoreEvent, EventBus

    errs: list[str] = []
    data_tmp = Path(tempfile.mkdtemp(prefix="neyra_ops_test_"))
    modules_tmp = Path(tempfile.mkdtemp(prefix="neyra_mods_test_"))

    def _make_zip(pid: str, *, enabled: bool = True, extra: dict[str, bytes] | None = None) -> bytes:
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            manifest = (
                f"id: {pid}\nname: t\nenabled: {'true' if enabled else 'false'}\n"
                "lifecycle: on_demand\nmain_script: main.py\n"
            )
            zf.writestr(f"{pid}/plugin.yaml", manifest)
            zf.writestr(f"{pid}/main.py", "# x\n")
            extras = dict(extra or {})
            if "config.yaml" not in extras:
                extras["config.yaml"] = b"k: v\n"
            for name, raw in extras.items():
                zf.writestr(f"{pid}/{name}", raw)
        return buf.getvalue()

    # --- unit: zip-slip ---
    bad = io.BytesIO()
    with zipfile.ZipFile(bad, "w") as zf:
        zf.writestr("plugin.yaml", "id: evil\nenabled: false\n")
        zf.writestr("../escape.py", "x")
    try:
        ops.install_plugin_from_zip(modules_tmp, bad.getvalue())
        errs.append("zip-slip must raise ValueError")
    except ValueError:
        pass
    except Exception as e:
        errs.append(f"zip-slip want ValueError, got {type(e).__name__}: {e}")

    # --- unit: enabled forced false + no replace ---
    z1 = _make_zip("ar_tmp_mod", enabled=True)
    info = ops.install_plugin_from_zip(modules_tmp, z1)
    py = yaml.safe_load((modules_tmp / "ar_tmp_mod" / "plugin.yaml").read_text(encoding="utf-8"))
    if py.get("enabled") is not False:
        errs.append(f"install must force enabled=false, got {py.get('enabled')}")
    (modules_tmp / "ar_tmp_mod" / "config.yaml").write_text("kept: true\n", encoding="utf-8")
    (modules_tmp / "ar_tmp_mod" / "logs").mkdir(exist_ok=True)
    (modules_tmp / "ar_tmp_mod" / "logs" / "module.log").write_text("old\n", encoding="utf-8")
    try:
        ops.install_plugin_from_zip(modules_tmp, z1, replace=False)
        errs.append("second install without replace must raise FileExistsError")
    except FileExistsError:
        pass
    z2 = _make_zip("ar_tmp_mod", enabled=True, extra={"config.yaml": b"from_zip: 1\n"})
    ops.install_plugin_from_zip(modules_tmp, z2, replace=True)
    cfg_txt = (modules_tmp / "ar_tmp_mod" / "config.yaml").read_text(encoding="utf-8")
    if "kept: true" not in cfg_txt:
        errs.append(f"replace must preserve local config.yaml, got {cfg_txt!r}")
    if not (modules_tmp / "ar_tmp_mod" / "logs" / "module.log").is_file():
        errs.append("replace must preserve logs/")
    olds = list(modules_tmp.glob(".ar_tmp_mod.old-*"))
    if len(olds) != 1:
        errs.append(f"successful replace must leave exactly one .old backup, got {olds}")
    ops.install_plugin_from_zip(modules_tmp, z2, replace=True)
    olds2 = list(modules_tmp.glob(".ar_tmp_mod.old-*"))
    if len(olds2) != 1:
        errs.append(f"second replace must still leave exactly one .old, got {olds2}")

    # Nested plugin.yaml must stay byte-identical (AR-25).
    nested_raw = b"foo: bar\nkeep: true\n"
    z_nested = _make_zip("ar_tmp_mod", enabled=True, extra={"sub/plugin.yaml": nested_raw})
    ops.install_plugin_from_zip(modules_tmp, z_nested, replace=True)
    nested_path = modules_tmp / "ar_tmp_mod" / "sub" / "plugin.yaml"
    if not nested_path.is_file() or nested_path.read_bytes() != nested_raw:
        errs.append(f"nested plugin.yaml must be unchanged, got {nested_path.read_bytes()!r}")
    root_py = yaml.safe_load((modules_tmp / "ar_tmp_mod" / "plugin.yaml").read_text(encoding="utf-8"))
    if not isinstance(root_py, dict) or root_py.get("enabled") is not False:
        errs.append(f"root plugin.yaml must be disabled after install: {root_py}")

    # Concurrent replace under lock (AR-23).
    import threading

    (modules_tmp / "ar_tmp_mod" / "data").mkdir(exist_ok=True)
    (modules_tmp / "ar_tmp_mod" / "data" / "keep.bin").write_bytes(b"keep-me")
    z_conc = _make_zip(
        "ar_tmp_mod",
        enabled=True,
        extra={"extra.txt": b"hello-concurrent\n", "config.yaml": b"from_zip: 1\n"},
    )
    conc_errs: list[str] = []

    def _conc_worker() -> None:
        try:
            ops.install_plugin_from_zip(modules_tmp, z_conc, replace=True)
        except Exception as e:
            conc_errs.append(f"{type(e).__name__}: {e}")

    threads = [threading.Thread(target=_conc_worker) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=30)
    if conc_errs:
        errs.append(f"concurrent replace failed: {conc_errs}")
    if not (modules_tmp / "ar_tmp_mod" / "extra.txt").is_file():
        errs.append("concurrent replace missing extra.txt from zip")
    if not (modules_tmp / "ar_tmp_mod" / "data" / "keep.bin").is_file():
        errs.append("concurrent replace lost preserved data/")
    if len(list(modules_tmp.glob(".ar_tmp_mod.old-*"))) != 1:
        errs.append("concurrent replace must leave exactly one .old")

    # --- unit: copy-preserve failure before swap leaves live data (AR-20) ---
    plug = modules_tmp / "ar_tmp_mod"
    (plug / "data").mkdir(exist_ok=True)
    (plug / "data" / "keep.bin").write_bytes(b"keep-me")
    real_copytree = shutil.copytree

    def flaky_copytree(src, dst, *a, **k):  # type: ignore[no-untyped-def]
        if Path(src).name == "data":
            raise OSError("simulated disk full on data/")
        return real_copytree(src, dst, *a, **k)

    try:
        with patch("shutil.copytree", flaky_copytree):
            ops.install_plugin_from_zip(modules_tmp, _make_zip("ar_tmp_mod"), replace=True)
        errs.append("flaky preserve copy must raise")
    except OSError:
        pass
    if not (plug / "data" / "keep.bin").is_file():
        errs.append("failed preserve copy must leave live data/ intact")
    if not (plug / "logs" / "module.log").is_file():
        errs.append("failed preserve copy must leave live logs/ intact")
    if list(modules_tmp.glob(".ar_tmp_mod.staging-*")):
        errs.append("staging must be cleaned after failed preserve copy")

    # --- unit: hidden staging dirs are not discovered (AR-21) ---
    from core.plugins.loader import PluginLoader

    loader_root = Path(tempfile.mkdtemp(prefix="neyra_loader_root_"))
    try:
        (loader_root / "modules").mkdir()
        hid = loader_root / "modules" / ".foo.staging-x"
        hid.mkdir()
        (hid / "plugin.yaml").write_text(
            "id: foo\nname: hidden\nenabled: true\nlifecycle: resident\nmain_script: main.py\n",
            encoding="utf-8",
        )
        (hid / "main.py").write_text("# x\n", encoding="utf-8")
        found = [m.id for m in PluginLoader(loader_root).discover_manifests()]
        if "foo" in found:
            errs.append("discover_manifests must skip .{id}.staging-* dirs")
    finally:
        shutil.rmtree(loader_root, ignore_errors=True)

    # --- unit: read allowlist + real path escape (allowlisted suffix) ---
    plug = modules_tmp / "ar_tmp_mod"
    other = modules_tmp / "other_mod"
    other.mkdir(exist_ok=True)
    (other / "config.yaml").write_text("secret: 1\n", encoding="utf-8")
    (plug / ".env").write_text("SECRET=1\n", encoding="utf-8")
    try:
        ops.read_plugin_file(plug, ".env")
        errs.append("read .env must be denied")
    except ValueError:
        pass
    try:
        ops.read_plugin_file(plug, "main.py")
        errs.append("read main.py must be denied")
    except ValueError:
        pass
    try:
        ops.read_plugin_file(plug, "../other_mod/config.yaml")
        errs.append("read path escape must raise")
    except ValueError as e:
        if "escape" not in str(e).lower():
            errs.append(f"read escape message should mention escape: {e}")
    try:
        ops.write_plugin_file(plug, "../other_mod/config.yaml", "x: 2\n")
        errs.append("write path escape must raise")
    except ValueError as e:
        if "escape" not in str(e).lower():
            errs.append(f"write escape message should mention escape: {e}")
    try:
        ops.resolve_under(plug, "../other_mod/config.yaml")
        errs.append("resolve_under escape must raise")
    except ValueError as e:
        if "escape" not in str(e).lower():
            errs.append(f"resolve_under message should mention escape: {e}")

    try:
        ops.install_plugin_from_zip(modules_tmp, _make_zip("discord"))
        errs.append("upload discord must be denied")
    except ValueError:
        pass

    # --- unit: corrupt replace leaves old module (AR-16) ---
    (plug / "main.py").write_text("# ORIGINAL\n", encoding="utf-8")
    (plug / "plugin.yaml").write_text(
        "id: ar_tmp_mod\nenabled: false\nlifecycle: on_demand\nmain_script: main.py\n",
        encoding="utf-8",
    )
    read_calls = {"n": 0}
    real_read = zipfile.ZipFile.read

    def flaky_read(self, name, *a, **k):  # type: ignore[no-untyped-def]
        read_calls["n"] += 1
        if read_calls["n"] >= 3:
            raise zipfile.BadZipFile("Bad CRC-32 for file")
        return real_read(self, name, *a, **k)

    try:
        with patch.object(zipfile.ZipFile, "read", flaky_read):
            ops.install_plugin_from_zip(modules_tmp, _make_zip("ar_tmp_mod"), replace=True)
        errs.append("flaky CRC replace must raise")
    except ValueError:
        pass
    except zipfile.BadZipFile:
        errs.append("BadZipFile should be wrapped as ValueError")
    if (plug / "main.py").read_text(encoding="utf-8") != "# ORIGINAL\n":
        errs.append("corrupt replace must leave old main.py intact")
    if not (plug / "plugin.yaml").is_file():
        errs.append("corrupt replace must leave old plugin.yaml intact")
    leftover_staging = list(modules_tmp.glob(".ar_tmp_mod.staging-*"))
    if leftover_staging:
        errs.append(f"staging dirs left after failed replace: {leftover_staging}")

    # --- API roles + webhook bus (isolated project_root) ---
    api_root = Path(tempfile.mkdtemp(prefix="neyra_api_root_"))
    (api_root / "modules").mkdir()
    (api_root / "logs").mkdir()
    # Stub protected plugin so delete/upload protection is reachable.
    disc = api_root / "modules" / "discord"
    disc.mkdir()
    (disc / "plugin.yaml").write_text(
        "id: discord\nname: d\nenabled: false\nlifecycle: resident\nmain_script: main.py\n",
        encoding="utf-8",
    )
    (disc / "main.py").write_text("# stub\n", encoding="utf-8")

    agent = MagicMock()
    agent.chat = AsyncMock(return_value={"reply": "ok"})
    agent.chat_stream = AsyncMock()
    agent.start_mcp_clients = AsyncMock()
    agent.stop_mcp_clients = AsyncMock()
    agent.memory_hub = None
    agent.long_memory = MagicMock(count=MagicMock(return_value=0))
    agent.event_bus = EventBus()
    monitor = MagicMock()
    monitor.start = MagicMock()
    monitor.run_once = AsyncMock(return_value={"status": "ok"})
    cfg = {
        "paths": {"data_dir": str(data_tmp)},
        "api": {
            "host": "127.0.0.1",
            "port": 8787,
            "token": "admin-secret",
            "viewer_token": "viewer-secret",
            "maint_token": "maint-secret",
            "public_base_url": "",
            "audit_log_enabled": False,
            "rate_limit_requests_per_minute": 0,
        },
        "dashboard": {"enabled": False},
        "llm": {
            "talk_model": {"provider": "openrouter", "model": "x"},
            "brain_model": {"provider": "openrouter", "model": "x"},
            "memory_model": {"provider": "openrouter", "model": "x"},
            "vision_model": {"provider": "openrouter", "model": "x"},
            "providers": {"openrouter": {"model": "x"}},
        },
    }
    api_pid = "ar_tmp_api_mod"
    app = build_app(
        cfg,
        shared_agent=agent,
        shared_monitor=monitor,
        shared_backup_manager=MagicMock(),
        project_root=api_root,
    )
    admin = {"Authorization": "Bearer admin-secret"}
    viewer = {"Authorization": "Bearer viewer-secret"}
    try:
        with TestClient(app, client=("127.0.0.1", 50000)) as client:
            r = client.post(
                "/v1/plugins/upload",
                files={"file": ("m.zip", _make_zip(api_pid), "application/zip")},
                headers=viewer,
            )
            if r.status_code != 403:
                errs.append(f"viewer upload want 403, got {r.status_code}")

            r = client.post(
                "/v1/plugins/upload",
                files={"file": ("m.zip", _make_zip(api_pid), "application/zip")},
                headers=admin,
            )
            if r.status_code != 200:
                errs.append(f"admin upload want 200, got {r.status_code} {r.text[:160]}")
            else:
                r2 = client.post(
                    "/v1/plugins/upload",
                    files={"file": ("m.zip", _make_zip(api_pid), "application/zip")},
                    headers=admin,
                )
                if r2.status_code != 409:
                    errs.append(f"duplicate upload want 409, got {r2.status_code}")

            r = client.post(
                "/v1/plugins/upload",
                files={"file": ("d.zip", _make_zip("discord"), "application/zip")},
                headers=admin,
            )
            if r.status_code != 400:
                errs.append(f"upload discord want 400, got {r.status_code}")

            r = client.delete("/v1/plugins/discord", headers=admin)
            if r.status_code != 403:
                errs.append(f"delete discord want 403, got {r.status_code}")

            r = client.get(f"/v1/plugins/{api_pid}/files/main.py", headers=viewer)
            if r.status_code != 400:
                errs.append(f"viewer read main.py want 400, got {r.status_code}")

            # Encoded .. so the server sees traversal (httpx would normalize bare ../).
            r = client.get(
                f"/v1/plugins/{api_pid}/files/%2e%2e/discord/plugin.yaml",
                headers=viewer,
            )
            if r.status_code != 400:
                errs.append(f"files %2e%2e traversal want 400, got {r.status_code} {r.text[:120]}")

            r = client.put(
                f"/v1/plugins/{api_pid}/files/config.yaml",
                json={"content": "a: 1\n"},
                headers=viewer,
            )
            if r.status_code != 403:
                errs.append(f"viewer PUT file want 403, got {r.status_code}")

            r = client.post(
                "/v1/webhooks/out/routes",
                json={
                    "event_type": "chat.turn_completed",
                    "target_url": "http://127.0.0.1:9/hook",
                    "secret": "shared-secret-xyz",
                    "enabled": True,
                    "max_retries": 0,
                },
                headers=admin,
            )
            if r.status_code != 200:
                errs.append(f"webhook create want 200, got {r.status_code}")
            r = client.post(
                "/v1/webhooks/out/routes",
                json={
                    "event_type": "memory.added",
                    "target_url": "http://127.0.0.1:9/hook",
                    "secret": "",
                    "enabled": True,
                    "max_retries": 0,
                },
                headers=admin,
            )
            if r.status_code != 200:
                errs.append(f"webhook create (copy secret) want 200, got {r.status_code}")
            r = client.post(
                "/v1/webhooks/out/routes",
                json={
                    "event_type": "*",
                    "target_url": "http://127.0.0.1:9/hook-all",
                    "secret": "star-secret",
                    "enabled": True,
                    "max_retries": 0,
                },
                headers=admin,
            )
            if r.status_code != 200:
                errs.append(f"webhook * route want 200, got {r.status_code}")

            routes = client.get("/v1/webhooks/out/routes", headers=admin)
            if routes.status_code == 200:
                rows = (routes.json().get("data") or {}).get("routes") or []
                same = [x for x in rows if x.get("target_url") == "http://127.0.0.1:9/hook"]
                mem = next((x for x in same if x.get("event_type") == "memory.added"), None)
                if not mem or not mem.get("secret_masked"):
                    errs.append(f"new route must inherit secret_masked from sibling: {mem}")

            agent.event_bus.publish(CoreEvent("chat.turn_completed", "verify", {"ping": True}))
            found = False
            for _ in range(40):
                time.sleep(0.05)
                d = client.get("/v1/webhooks/deliveries", headers=admin)
                if d.status_code != 200:
                    continue
                rows = (d.json().get("data") or {}).get("deliveries") or []
                for x in rows:
                    pl = x.get("payload") if isinstance(x.get("payload"), dict) else {}
                    if pl.get("event_type") == "chat.turn_completed" and x.get("source") == "event_bus":
                        found = True
                        break
                if found:
                    break
            if not found:
                errs.append("event_bus publish did not create webhook delivery")

            # Wildcard route + publish from a foreign event loop (AR-17/18).
            import threading

            def _publish_from_other_loop() -> None:
                async def _go() -> None:
                    agent.event_bus.publish(CoreEvent("music.play", "discord", {"track": "x"}))

                asyncio.run(_go())

            t = threading.Thread(target=_publish_from_other_loop, daemon=True)
            t.start()
            t.join(timeout=5)
            star_ok = False
            for _ in range(40):
                time.sleep(0.05)
                d = client.get("/v1/webhooks/deliveries", headers=admin)
                if d.status_code != 200:
                    continue
                rows = (d.json().get("data") or {}).get("deliveries") or []
                for x in rows:
                    if (
                        x.get("event_type") == "music.play"
                        and x.get("source") == "event_bus"
                        and x.get("route_event") == "*"
                    ):
                        star_ok = True
                        break
                if star_ok:
                    break
            if not star_ok:
                errs.append(
                    "wildcard * route + foreign-loop publish must deliver "
                    "event_type=music.play with route_event=*"
                )

            r = client.delete(f"/v1/plugins/{api_pid}", headers=viewer)
            if r.status_code != 403:
                errs.append(f"viewer delete want 403, got {r.status_code}")
            r = client.delete(f"/v1/plugins/{api_pid}", headers=admin)
            if r.status_code != 200:
                errs.append(f"admin delete want 200, got {r.status_code}")
    finally:
        shutil.rmtree(api_root, ignore_errors=True)
        shutil.rmtree(data_tmp, ignore_errors=True)
        shutil.rmtree(modules_tmp, ignore_errors=True)
    return errs


def check_webhook_hmac_and_dlq_retry() -> list[str]:
    """AR-35/37/40/41: HMAC bytes + real POST retry-all on ephemeral project_root."""
    import hashlib
    import hmac as hmac_mod
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from fastapi.testclient import TestClient

    from core.api import build_app
    from core.api.app import webhook_signature_headers
    from core.runtime.event_bus import EventBus

    errs: list[str] = []

    body = b'{"event_type":"x","ping":true}'
    secret = "unit-test-secret"
    ts = "1700000000"
    headers = webhook_signature_headers(secret, body, ts=ts)
    expect = hmac_mod.new(
        secret.encode("utf-8"),
        f"{ts}.".encode("utf-8") + body,
        hashlib.sha256,
    ).hexdigest()
    if headers.get("X-Neyra-Signature") != f"sha256={expect}":
        errs.append(f"HMAC signature mismatch: {headers.get('X-Neyra-Signature')!r}")
    if headers.get("X-Neyra-Timestamp") != ts:
        errs.append(f"HMAC timestamp mismatch: {headers.get('X-Neyra-Timestamp')!r}")

    hits: dict[str, int] = {"ok": 0, "fail": 0, "bad_sig": 0}

    class _Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            sig = self.headers.get("X-Neyra-Signature") or ""
            ts_h = self.headers.get("X-Neyra-Timestamp") or ""
            sec = self.headers.get("x-neyra-webhook-secret") or ""
            dig = hmac_mod.new(
                sec.encode("utf-8"),
                f"{ts_h}.".encode("utf-8") + raw,
                hashlib.sha256,
            ).hexdigest()
            if sig != f"sha256={dig}":
                hits["bad_sig"] += 1
                self.send_response(401)
                self.end_headers()
                return
            if self.path.endswith("/ok"):
                hits["ok"] += 1
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b"ok")
            else:
                hits["fail"] += 1
                self.send_response(500)
                self.end_headers()
                self.wfile.write(b"fail")

        def log_message(self, *_args: Any) -> None:
            return

    # AR-40: seed a "live" webhooks file and prove verify does not touch it.
    live_wh = SERVER_ROOT / "logs" / "webhooks_state.json"
    live_wh.parent.mkdir(parents=True, exist_ok=True)
    live_marker = {
        "routes": {"keep_me": {"route_id": "keep_me", "secret": "live-secret-do-not-touch"}},
        "deliveries": {},
        "dlq": {},
        "_ar40_marker": "preserve",
    }
    live_before = json.dumps(live_marker, ensure_ascii=False, indent=2)
    live_wh.write_text(live_before, encoding="utf-8")

    httpd = HTTPServer(("127.0.0.1", 0), _Handler)
    port = int(httpd.server_address[1])
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    api_root = Path(tempfile.mkdtemp(prefix="neyra_dlq_api_"))
    data_tmp = Path(tempfile.mkdtemp(prefix="neyra_dlq_data_"))
    try:
        (api_root / "logs").mkdir(parents=True)
        (api_root / "modules").mkdir(parents=True)
        seed = {
            "routes": {
                "route_ok": {
                    "route_id": "route_ok",
                    "event_type": "debug.ok",
                    "target_url": f"http://127.0.0.1:{port}/ok",
                    "secret": "hook-secret",
                    "enabled": True,
                    "max_retries": 0,
                },
                "route_fail": {
                    "route_id": "route_fail",
                    "event_type": "debug.fail",
                    "target_url": f"http://127.0.0.1:{port}/fail",
                    "secret": "hook-secret",
                    "enabled": True,
                    "max_retries": 0,
                },
            },
            "deliveries": {
                "d_ok": {
                    "delivery_id": "d_ok",
                    "route_id": "route_ok",
                    "status": "failed",
                    "payload": {"event_type": "debug.ok", "n": 1},
                },
                "d_fail": {
                    "delivery_id": "d_fail",
                    "route_id": "route_fail",
                    "status": "failed",
                    "payload": {"event_type": "debug.fail", "n": 2},
                },
            },
            "dlq": {
                "d_ok": {
                    "delivery_id": "d_ok",
                    "route_id": "route_ok",
                    "status": "failed",
                    "payload": {"event_type": "debug.ok", "n": 1},
                },
                "d_fail": {
                    "delivery_id": "d_fail",
                    "route_id": "route_fail",
                    "status": "failed",
                    "payload": {"event_type": "debug.fail", "n": 2},
                },
            },
        }
        (api_root / "logs" / "webhooks_state.json").write_text(
            json.dumps(seed, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        agent = MagicMock()
        agent.chat = AsyncMock(return_value={"reply": "ok"})
        agent.chat_stream = AsyncMock()
        agent.start_mcp_clients = AsyncMock()
        agent.stop_mcp_clients = AsyncMock()
        agent.memory_hub = None
        agent.long_memory = MagicMock(count=MagicMock(return_value=0))
        agent.event_bus = EventBus()
        monitor = MagicMock()
        monitor.start = MagicMock()
        monitor.run_once = AsyncMock(return_value={"status": "ok"})
        app = build_app(
            {
                "paths": {"data_dir": str(data_tmp)},
                "api": {
                    "host": "127.0.0.1",
                    "port": 8787,
                    "token": "admin-secret",
                    "viewer_token": "viewer-secret",
                    "maint_token": "maint-secret",
                    "public_base_url": "",
                    "public_path_prefix": "/api",
                    "audit_log_enabled": False,
                    "rate_limit_requests_per_minute": 0,
                    "websocket": {
                        "idle_timeout_seconds": 5,
                        "ping_interval_seconds": 20,
                        "close_grace_seconds": 1,
                    },
                },
                "dashboard": {"enabled": False},
                "llm": {
                    "talk_model": {"provider": "openrouter", "model": "x"},
                    "brain_model": {"provider": "openrouter", "model": "x"},
                    "memory_model": {"provider": "openrouter", "model": "x"},
                    "vision_model": {"provider": "openrouter", "model": "x"},
                    "providers": {"openrouter": {"model": "x"}},
                },
            },
            shared_agent=agent,
            shared_monitor=monitor,
            shared_backup_manager=MagicMock(),
            project_root=api_root,
        )
        admin = {"Authorization": "Bearer admin-secret"}
        with TestClient(app, client=("127.0.0.1", 50000)) as client:
            r1 = client.post("/v1/webhooks/dlq/retry-all", headers=admin)
            if r1.status_code != 202:
                errs.append(f"retry-all want 202, got {r1.status_code} {r1.text[:160]}")
            queued = ((r1.json().get("data") or {}).get("queued")) if r1.status_code == 202 else None
            if queued != 2:
                errs.append(f"first retry-all queued want 2, got {queued}")

            # Second call must claim 0 (already retrying / done) — no duplicate ok POSTs.
            r2 = client.post("/v1/webhooks/dlq/retry-all", headers=admin)
            if r2.status_code != 202:
                errs.append(f"second retry-all want 202, got {r2.status_code}")
            else:
                q2 = (r2.json().get("data") or {}).get("queued")
                if q2 not in (0,):
                    # After first background finished, DLQ may have 1 failed left — claiming that is ok
                    # but ok route must not be re-sent. Check hits["ok"] below.
                    if q2 not in (0, 1):
                        errs.append(f"second retry-all queued unexpected: {q2}")

            dlq = client.get("/v1/webhooks/dlq", headers=admin)
            if dlq.status_code != 200:
                errs.append(f"GET dlq want 200, got {dlq.status_code}")
            else:
                items = (dlq.json().get("data") or {}).get("items") or []
                # After retry: ok removed; fail replaced by one new failed delivery (or still retrying→failed).
                fail_items = [x for x in items if str(x.get("route_id") or "") == "route_fail"]
                ok_items = [x for x in items if str(x.get("route_id") or "") == "route_ok"]
                if ok_items:
                    errs.append(f"DLQ must not keep route_ok after successful retry: {ok_items}")
                if len(fail_items) != 1:
                    errs.append(f"DLQ want exactly 1 route_fail row, got {len(fail_items)}: {fail_items}")

            if hits["bad_sig"]:
                errs.append(f"receiver saw bad HMAC {hits['bad_sig']} times")
            if hits["ok"] != 1:
                errs.append(f"ok receiver want exactly 1 POST, got {hits['ok']}")
            if hits["fail"] < 1:
                errs.append("fail receiver expected at least 1 POST")

        live_after = live_wh.read_text(encoding="utf-8") if live_wh.is_file() else ""
        if live_after != live_before:
            errs.append("AR-40: live server/logs/webhooks_state.json was modified by verify")
    finally:
        try:
            httpd.shutdown()
        except Exception:
            pass
        shutil.rmtree(api_root, ignore_errors=True)
        shutil.rmtree(data_tmp, ignore_errors=True)
        # Restore live marker only if we created the AR-40 probe (leave real prod alone otherwise).
        try:
            if live_wh.is_file() and '"_ar40_marker": "preserve"' in live_wh.read_text(encoding="utf-8"):
                live_wh.unlink()
        except OSError:
            pass

    return errs


def main() -> int:
    checks = [
        ("package layout", check_package_layout),
        ("public url helper", check_public_url_helper),
        ("config api key", check_config_key_api),
        ("no legacy imports", check_no_legacy_imports),
        ("build_app routes", check_build_app_routes),
        ("bind gate", check_bind_gate),
        ("legacy env failfast", check_legacy_env_failfast),
        ("API_KEY alias", check_api_key_alias),
        ("dashboard gate store", check_dashboard_gate_store),
        ("spa routes", check_spa_routes),
        ("public URL env rejected", check_public_url_env_rejected),
        ("rate limit XFF bucket", check_rate_limit_xff_bucket),
        ("auth matrix", check_auth_matrix),
        ("plugin ops & webhooks", check_plugin_ops_and_webhooks),
        ("webhook HMAC & DLQ retry", check_webhook_hmac_and_dlq_retry),
        ("merge proposals API", check_merge_proposals_api),
    ]
    failed = 0
    for name, fn in checks:
        try:
            errs = fn()
        except Exception as e:
            print(f"FAIL {name}: {type(e).__name__}: {e}")
            failed += 1
            continue
        if errs:
            print(f"FAIL {name}:")
            for e in errs:
                print(f"  - {e}")
            failed += 1
        else:
            print(f"OK {name}")
    if failed:
        print(f"\n{failed} check group(s) failed")
        return 1
    print("\nAll Stage 2 API checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
