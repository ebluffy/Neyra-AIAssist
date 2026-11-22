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

# A provider rate limit within this window makes the backend check degraded:
# /v1/models may still answer 200 while every real turn fails with HTTP 429.
LLM_DEGRADATION_WINDOW_SECONDS = 600


def discord_resident_enabled(project_root: Optional[Path]) -> bool:
    """Whether the resident discord plugin is enabled in plugin.yaml."""
    root = Path(project_root) if project_root is not None else None
    if root is None:
        return False
    try:
        from core.plugins.loader import PluginLoader

        for manifest in PluginLoader(root).discover_manifests():
            if manifest.id == "discord" and manifest.enabled and manifest.lifecycle == "resident":
                return True
    except Exception:
        return False
    return False


def check_lavalink(config: dict) -> dict:
    """Check configured Lavalink nodes; passwords and userinfo never leave this function."""
    try:
        discord = config.get("discord") if isinstance(config, dict) else None
        music = (discord or {}).get("music") if isinstance(discord, dict) else None
        raw_nodes = (music or {}).get("nodes") if isinstance(music, dict) else None
        if not isinstance(raw_nodes, list):
            return {"checked": False, "ok": True, "reason": "no music nodes"}
        nodes = [
            node
            for node in raw_nodes
            if isinstance(node, dict) and str(node.get("uri") or "").strip()
        ]
        if not nodes:
            return {"checked": False, "ok": True, "reason": "no music nodes"}
        import httpx

        timeout = httpx.Timeout(2.0, connect=1.0)
        errors: list[str] = []
        status_code = None
        version = None
        plugins: list[str] = []
        ok_count = 0
        for node in nodes:
            uri = str(node.get("uri") or "").strip().rstrip("/")
            password = str(node.get("password") or "").strip()
            try:
                response = httpx.get(
                    f"{uri}/v4/info",
                    headers={"Authorization": password} if password else {},
                    timeout=timeout,
                )
                status_code = response.status_code
                if response.status_code != 200:
                    errors.append(f"http {response.status_code}")
                    continue
                payload = (
                    response.json()
                    if response.headers.get("content-type", "").startswith("application/json")
                    else {}
                )
                if not isinstance(payload, dict):
                    payload = {}
                ok_count += 1
                version = payload.get("version") or version
                plugins = plugins or [
                    str(item.get("name"))
                    for item in (payload.get("plugins") or [])
                    if isinstance(item, dict) and item.get("name")
                ]
            except Exception as error:
                errors.append(type(error).__name__)
        result = {
            "checked": True,
            "ok": ok_count > 0,
            "nodes_total": len(nodes),
            "nodes_ok": ok_count,
        }
        if status_code is not None:
            result["status_code"] = status_code
        if version is not None:
            result["version"] = version
        if plugins:
            result["plugins"] = plugins
        if ok_count == 0:
            result["error"] = errors[0] if errors else "unavailable"
        return result
    except Exception as e:
        logger.warning("lavalink health check failed", exc_info=True)
        return {"checked": True, "ok": False, "error": type(e).__name__}


class HealthMonitor:
    def __init__(
        self,
        config: dict,
        *,
        project_root: Optional[Path] = None,
        process_registry: Optional[Callable[[], dict]] = None,
        restart_callback: Optional[Callable[[str], tuple[bool, str]]] = None,
        llm_activity: Optional[Callable[[], Optional[dict]]] = None,
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
        # Probe from the /v1/llm/activity source: latest provider 429 in the window.
        self.llm_activity = llm_activity
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
            "integrations": await asyncio.to_thread(self._check_integrations),
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

        # The /models probe cannot see a provider rate-limit storm: the endpoint may
        # keep answering 200 while every real turn dies with HTTP 429. Fold the recent
        # activity signal in so health never reports a green backend for a silent assistant.
        degraded_reason = None
        if self.llm_activity is not None:
            try:
                degraded_reason = self.llm_activity()
            except Exception:
                logger.debug("llm activity probe failed", exc_info=True)
                degraded_reason = None

        def _apply_degradation(out: dict) -> dict:
            if degraded_reason:
                out["degraded"] = True
                out["degraded_reason"] = degraded_reason
                out["ok"] = False
            else:
                out["degraded"] = False
            return out

        conns = list(iter_unique_provider_connections(self.config))
        if not conns:
            return _apply_degradation({"ok": False, "error": "no_llm_providers", "providers": []})

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
        return _apply_degradation(out)

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
                return {"ok": True, "issues": [], "lavalink": {"checked": False}}
            token = str(
                (os.environ.get("DISCORD_TOKEN") or "")
                or (self.config.get("discord") or {}).get("token")
                or ""
            ).strip()
            if not token:
                issues.append("discord resident enabled in plugin.yaml but DISCORD_TOKEN is missing")
            lavalink = check_lavalink(self.config)
            if lavalink.get("checked") and not lavalink.get("ok"):
                issues.append(
                    "lavalink is not ready: "
                    + str(lavalink.get("error") or lavalink.get("status_code") or "unknown")
                )
            return {"ok": len(issues) == 0, "issues": issues, "lavalink": lavalink}
        except Exception as e:
            return {"ok": False, "error": str(e)[:500]}

    def _discord_resident_enabled(self) -> bool:
        return discord_resident_enabled(self._project_root)

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
