"""
Hourly health monitor + simple self-healing for spawned interface modules.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

logger = logging.getLogger("neyra.health")


class HealthMonitor:
    def __init__(
        self,
        config: dict,
        *,
        project_root: Optional[Path] = None,
        process_registry: Optional[Callable[[], dict]] = None,
        restart_callback: Optional[Callable[[str], tuple[bool, str]]] = None,
    ):
        self.config = config or {}
        self._project_root = Path(project_root).resolve() if project_root is not None else None
        mon_cfg = (self.config.get("health_monitor") or {}) if isinstance(self.config, dict) else {}
        self.enabled = bool(mon_cfg.get("enabled", True))
        self.interval_seconds = max(60, int(mon_cfg.get("interval_seconds", 3600)))
        self.llm_timeout_seconds = max(2, float(mon_cfg.get("llm_timeout_seconds", 10)))
        self.log_path = Path(mon_cfg.get("status_log", "./logs/health_status.jsonl"))
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self.process_registry = process_registry
        self.restart_callback = restart_callback
        self._task: Optional[asyncio.Task] = None
        self._last_report: dict = {}

    @property
    def last_report(self) -> dict:
        return dict(self._last_report)

    async def run_once(self) -> dict:
        report = {
            "timestamp": datetime.now().isoformat(),
            "backend": await self._check_backend(),
            "storage": self._check_storage(),
            "integrations": self._check_integrations(),
            "self_healing": await self._check_and_heal_modules(),
        }
        report["ok"] = all(
            bool(report[k].get("ok", False))
            for k in ("backend", "storage", "integrations", "self_healing")
        )
        self._last_report = report
        self._append_report(report)
        if report["ok"]:
            logger.info("Health monitor OK | backend=%s", report["backend"].get("provider"))
        else:
            logger.warning("Health monitor WARN | report=%s", report)
        return report

    def start(self) -> None:
        if not self.enabled:
            logger.info("Health monitor disabled by config.")
            return
        if self._task and not self._task.done():
            return
        loop = asyncio.get_running_loop()
        self._task = loop.create_task(self._worker(), name="neyra-health-monitor")
        logger.info("Health monitor started | interval=%ss", self.interval_seconds)

    async def stop(self) -> None:
        if not self._task:
            return
        self._task.cancel()
        try:
            await self._task
        except asyncio.CancelledError:
            pass
        self._task = None

    async def _worker(self) -> None:
        while True:
            try:
                await self.run_once()
            except Exception as e:
                logger.exception("Health monitor worker error: %s", e)
            await asyncio.sleep(self.interval_seconds)

    async def _check_backend(self) -> dict:
        import httpx
        from core.llm.profile import iter_unique_provider_connections

        conns = list(iter_unique_provider_connections(self.config))
        if not conns:
            return {"ok": False, "error": "no_llm_providers", "providers": []}

        timeout = httpx.Timeout(self.llm_timeout_seconds, connect=min(8.0, self.llm_timeout_seconds))

        async def _one(conn) -> dict:
            base = conn.base_url.rstrip("/")
            url = f"{base}/models"
            headers = {}
            if conn.api_key and conn.api_key != "ollama":
                headers["Authorization"] = f"Bearer {conn.api_key}"
            try:
                r = await asyncio.to_thread(
                    httpx.get,
                    url,
                    headers=headers,
                    timeout=timeout,
                )
                return {
                    "ok": r.status_code < 400,
                    "provider": conn.provider,
                    "url": url,
                    "status_code": r.status_code,
                }
            except Exception as e:
                return {
                    "ok": False,
                    "provider": conn.provider,
                    "url": url,
                    "error": str(e)[:300],
                }

        providers = list(await asyncio.gather(*[_one(c) for c in conns]))
        ok = bool(providers) and all(bool(p.get("ok")) for p in providers)
        out: dict = {
            "ok": ok,
            "provider": ",".join(str(p.get("provider") or "") for p in providers),
            "providers": providers,
        }
        if len(providers) == 1:
            out["url"] = providers[0].get("url")
            out["status_code"] = providers[0].get("status_code")
            if providers[0].get("error"):
                out["error"] = providers[0]["error"]
        elif not ok:
            # Short summary for dashboard when several providers fail.
            bits = []
            for p in providers:
                if p.get("ok"):
                    continue
                if p.get("error"):
                    bits.append(f"{p.get('provider')}: {p.get('error')}")
                else:
                    bits.append(f"{p.get('provider')}: HTTP {p.get('status_code')}")
            if bits:
                out["error"] = "; ".join(bits)[:500]
        return out

    def _check_storage(self) -> dict:
        try:
            import time as _time

            from core.runtime.paths import resolve_data_dir

            mem = self.config.get("memory", {}) if isinstance(self.config, dict) else {}
            root = self._project_root or Path(".")
            data_dir = resolve_data_dir(root, self.config if isinstance(self.config, dict) else {})
            chroma_raw = Path(str(mem.get("chroma_db_path") or (data_dir / "memory" / "chroma_db")))
            chroma = chroma_raw if chroma_raw.is_absolute() else (root / chroma_raw)
            required_dirs = [
                root / "logs",
                data_dir / "memory",
                chroma,
            ]
            missing = [str(p) for p in required_dirs if not p.exists()]
            db_ok = True
            db_latency_ms = 0
            sqlite_path = Path(str(mem.get("sqlite_path") or (data_dir / "memory" / "neyra_memory.db")))
            if not sqlite_path.is_absolute():
                sqlite_path = root / sqlite_path
            if sqlite_path.is_file():
                import sqlite3

                t0 = _time.perf_counter()
                try:
                    conn = sqlite3.connect(str(sqlite_path), timeout=2)
                    try:
                        conn.execute("SELECT 1").fetchone()
                    finally:
                        conn.close()
                    db_latency_ms = int((_time.perf_counter() - t0) * 1000)
                except Exception:
                    db_ok = False
            return {
                "ok": not missing and db_ok,
                "missing": missing,
                "db_ok": db_ok,
                "db_latency_ms": db_latency_ms,
            }
        except Exception as e:
            return {"ok": False, "error": str(e)[:500]}

    def _check_integrations(self) -> dict:
        try:
            issues: list[str] = []
            if not isinstance(self.config, dict):
                return {"ok": True, "issues": []}
            if not self._discord_resident_enabled():
                return {"ok": True, "issues": []}
            token = str(
                (os.environ.get("DISCORD_TOKEN") or "")
                or (self.config.get("discord") or {}).get("token")
                or ""
            ).strip()
            if not token:
                issues.append("discord resident enabled in plugin.yaml but DISCORD_TOKEN is missing")
            return {"ok": len(issues) == 0, "issues": issues}
        except Exception as e:
            return {"ok": False, "error": str(e)[:500]}

    def _discord_resident_enabled(self) -> bool:
        """Включён ли resident-плагин discord в plugin.yaml (без дублирования в config.yaml плагина)."""
        root = self._project_root
        if root is None:
            return False
        try:
            from core.plugins.loader import PluginLoader

            for m in PluginLoader(root).discover_manifests():
                if m.id == "discord" and m.enabled and m.lifecycle == "resident":
                    return True
        except Exception:
            return False
        return False

    async def _check_and_heal_modules(self) -> dict:
        if not self.process_registry:
            return {"ok": True, "checked": 0, "restarted": []}
        try:
            proc_map = self.process_registry() or {}
            restarted: list[str] = []
            crashed: list[str] = []
            for mode, proc in proc_map.items():
                if proc is None:
                    continue
                poll = proc.poll()
                if poll is None:
                    continue
                crashed.append(f"{mode}:{poll}")
                if self.restart_callback:
                    ok, _ = self.restart_callback(mode)
                    if ok:
                        restarted.append(mode)
            ok = len(crashed) == len(restarted)
            return {
                "ok": ok,
                "checked": len(proc_map),
                "crashed": crashed,
                "restarted": restarted,
            }
        except Exception as e:
            return {"ok": False, "error": str(e)[:500]}

    def _append_report(self, report: dict) -> None:
        try:
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(report, ensure_ascii=False) + "\n")
        except Exception as e:
            logger.warning("Failed to write health report: %s", e)
