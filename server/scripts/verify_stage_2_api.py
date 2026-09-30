#!/usr/bin/env python3
"""Stage 2: core API package, api: config, meta/models helpers (offline)."""

from __future__ import annotations

import sys
from pathlib import Path

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
    from core.api import api_public_root, api_public_v1, API_VERSION

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
    if not API_VERSION:
        errs.append("API_VERSION empty")
    empty = api_public_root({"api": {}})
    if empty != "":
        errs.append(f"empty public_base_url should yield '', got {empty!r}")
    return errs


def check_config_key_api() -> list[str]:
    from core.runtime.config_loader import load_layered_yaml, validate_config_schema

    errs: list[str] = []
    cfg = load_layered_yaml(SERVER_ROOT)
    if "internal_api" in cfg:
        errs.append("layered cfg still has internal_api")
    api = cfg.get("api")
    if not isinstance(api, dict):
        errs.append("api: section missing from layered load")
    else:
        if "host" not in api or "port" not in api:
            errs.append("api.host/port missing")
        if "public_base_url" not in api:
            errs.append("api.public_base_url missing from example layer")
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


def main() -> int:
    checks = [
        ("package layout", check_package_layout),
        ("public url helper", check_public_url_helper),
        ("config api key", check_config_key_api),
        ("no legacy imports", check_no_legacy_imports),
        ("build_app routes", check_build_app_routes),
    ]
    failed = 0
    for name, fn in checks:
        try:
            errs = fn()
        except Exception as e:
            print(f"FAIL {name}: {e}")
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
