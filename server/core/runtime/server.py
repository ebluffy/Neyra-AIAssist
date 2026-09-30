"""
Единая точка запуска HTTP-стека Нейры: FastAPI + дашборд + тот же NeyraAgent,
что и у фоновых resident-плагинов (например Discord).

Дашборд — центр управления (далее — те же возможности в десктоп/мобильных приложениях).

Консольный режим (`python main.py --mode console`) — отдельный процесс для отладки промптов.
"""

from __future__ import annotations

import logging
import sys
import threading
from pathlib import Path

from fastapi import FastAPI

from core.neyra import NeyraAgent
from core.runtime.backup import BackupManager
from core.plugins import PluginContext, PluginLoader, run_plugin_entrypoint
from core.reflection import ReflectionEngine
from core.runtime.health import HealthMonitor

logger = logging.getLogger("neyra.server")


def project_root() -> Path:
    # core/runtime/server.py → parents[2] = server/
    return Path(__file__).resolve().parents[2]


def _start_resident_plugin_threads(config: dict, root: Path, agent: NeyraAgent) -> None:
    loader = PluginLoader(root)
    for manifest in loader.discover_manifests():
        if manifest.lifecycle != "resident":
            continue
        if not manifest.enabled:
            continue
        try:
            mod = loader.import_plugin_module(manifest)
        except Exception as e:
            logger.exception("Failed to load resident plugin %s: %s", manifest.id, e)
            continue

        ctx = PluginContext(root=root, config=config, agent=agent)

        mid = manifest.id

        def run_sync(
            captured_mod=mod,
            captured_ctx=ctx,
            plugin_id: str = mid,
        ) -> None:
            try:
                run_plugin_entrypoint(captured_mod, captured_ctx)
            except Exception as ex:
                logger.exception("Resident plugin %s crashed: %s", plugin_id, ex)

        t = threading.Thread(target=run_sync, name=f"neyra-resident-{mid}", daemon=True)
        t.start()
        logger.info("Started resident plugin thread: %s", mid)


def attach_resident_plugins(app: FastAPI, config: dict, root: Path, agent: NeyraAgent) -> None:
    """Регистрирует startup: фоновые потоки для lifecycle=resident."""

    @app.on_event("startup")
    async def _resident_startup() -> None:
        _start_resident_plugin_threads(config, root, agent)


def run_neyra_server(config: dict) -> None:
    """
    Запуск uvicorn: один агент, рефлексия, health monitor, HTTP API и дашборд;
    resident-плагины — в daemon-потоках после старта приложения.
    """
    import uvicorn

    from core.api import build_app
    from core.api import app as api_app
    from core.api.app import _dashboard_dist_path, assert_api_bind_safe

    root = project_root()
    assert_api_bind_safe(config)

    dash_cfg = config.get("dashboard") or {}
    dist = _dashboard_dist_path(config)
    if bool(dash_cfg.get("enabled", True)) and bool(dash_cfg.get("require_build", False)):
        if not (dist.is_dir() and (dist / "index.html").is_file()):
            logger.error(
                "dashboard.require_build is true but %s is missing. Build: cd dashboard && npm install && npm run build",
                dist,
            )
            sys.exit(1)

    agent = NeyraAgent(config)
    reflection = ReflectionEngine(config, agent)
    monitor = HealthMonitor(config, project_root=root)
    backup_manager = BackupManager(config)

    app = build_app(
        config,
        shared_agent=agent,
        shared_monitor=monitor,
        shared_backup_manager=backup_manager,
        reflection=reflection,
    )
    attach_resident_plugins(app, config, root, agent)

    api_cfg = config.get("api") or {}
    host = str(api_cfg.get("host") or "127.0.0.1")
    port = int(api_cfg.get("port") or 8787)
    log_level = str(api_cfg.get("level") or "info").lower()
    logger.info("Neyra core server | http://%s:%s/ (dashboard + /v1)", host, port)

    uvi_cfg = uvicorn.Config(
        app,
        host=host,
        port=port,
        log_level=log_level if log_level in ("debug", "info", "warning", "error") else "info",
        proxy_headers=True,
        forwarded_allow_ips="127.0.0.1",
    )
    server = uvicorn.Server(uvi_cfg)
    api_app._uvicorn_server = server
    try:
        server.run()
    finally:
        api_app._uvicorn_server = None
