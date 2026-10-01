#!/usr/bin/env python3
"""Stage 2: core API package, api: config, auth matrix (offline)."""

from __future__ import annotations

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
    ):
        if need not in text:
            errs.append(f"missing route decorator {need}")
    if "not_supported" not in text:
        errs.append("plugin reload/restart should raise not_supported")
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

    agent = MagicMock()
    agent.chat = AsyncMock(return_value={"reply": "ok"})
    agent.chat_stream = AsyncMock()
    agent.start_mcp_clients = AsyncMock()
    agent.stop_mcp_clients = AsyncMock()
    agent.memory_hub = None
    agent.long_memory = MagicMock(count=MagicMock(return_value=0))

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
