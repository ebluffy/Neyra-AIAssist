"""Offline regression for SoundCloud AAC-HLS source and Lavalink health."""
from __future__ import annotations

import asyncio
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock, Mock

import pytest

from core.runtime.health import HealthMonitor, check_lavalink
from modules.discord.lavalink_process import _ensure_soundy_yaml, _force_safe_lavalink_log_levels
from modules.discord.music import _connect_music_service, _normalize_play_query


def test_soundcloud_short_link_is_allowed_and_normalized():
    query, error = _normalize_play_query("включи https://on.soundcloud.com/2LXOaBGULBfOobRBcv")
    assert error is None
    assert query == "https://on.soundcloud.com/2LXOaBGULBfOobRBcv"


def test_soundy_yaml_disables_builtin_source_and_enables_plugin():
    text = (
        "lavalink:\n"
        "  server:\n"
        "    sources:\n"
        "      youtube: true\n"
        "      soundcloud: true\n"
        "plugins:\n"
        "  youtube:\n"
        "    enabled: true\n"
    )
    fixed, changed = _ensure_soundy_yaml(text)
    assert changed is True
    assert "soundcloud: false" in fixed
    assert "soundy:\n    enabled: true" in fixed
    assert fixed.count("soundcloud:") == 1


def test_soundy_yaml_repairs_disabled_plugin():
    text = "lavalink:\n  server:\n    sources:\n      soundcloud: false\nplugins:\n  soundy:\n    enabled: false\n"
    fixed, changed = _ensure_soundy_yaml(text)
    assert changed is True
    assert "soundy:\n    enabled: true" in fixed


def test_safe_lavalink_logs_drop_token_debug_levels():
    text = "logging:\n  level:\n    dev.lavalink.youtube: DEBUG\n    com.sedmelluq.discord.lavaplayer: TRACE\n"
    fixed, changed = _force_safe_lavalink_log_levels(text)
    assert changed is True
    assert "dev.lavalink.youtube: INFO" in fixed
    assert "com.sedmelluq.discord.lavaplayer: INFO" in fixed
    assert "DEBUG" not in fixed and "TRACE" not in fixed


def test_application_example_has_no_debug_or_trace_loggers():
    from pathlib import Path

    text = (Path(__file__).resolve().parents[1] / "modules" / "discord" / "lavalink" / "application.example.yml").read_text(encoding="utf-8")
    assert "DEBUG" not in text
    assert "TRACE" not in text


def test_check_lavalink_exception_returns_type_not_raw_text(monkeypatch):
    import httpx

    def fake_get(url, **kwargs):
        raise RuntimeError("secret internal address 127.0.0.1:9999")

    monkeypatch.setattr(httpx, "get", fake_get)
    result = check_lavalink(
        {"discord": {"music": {"nodes": [{"uri": "http://127.0.0.1:2333", "password": "secret"}]}}}
    )
    assert result["checked"] is True
    assert result["ok"] is False
    assert result["error"] == "RuntimeError"
    assert "127.0.0.1" not in str(result)
    assert "secret" not in str(result)


def test_check_lavalink_reports_version_without_password(monkeypatch):
    class Response:
        status_code = 200
        headers = {"content-type": "application/json"}

        def json(self):
            return {"version": {"semver": "4.2.2"}, "plugins": [{"name": "soundy", "version": "1.1.1"}]}

    captured = {}

    def fake_get(url, **kwargs):
        captured["url"] = url
        captured["headers"] = kwargs.get("headers", {})
        return Response()

    import httpx

    monkeypatch.setattr(httpx, "get", fake_get)
    result = check_lavalink(
        {"discord": {"music": {"nodes": [{"uri": "http://127.0.0.1:2333", "password": "secret"}]}}}
    )
    assert result["checked"] is True
    assert result["ok"] is True
    assert result["version"] == {"semver": "4.2.2"}
    assert "secret" not in str(result)
    assert captured["url"] == "http://127.0.0.1:2333/v4/info"


def test_music_recovery_restarts_dead_lavalink(monkeypatch):
    import modules.discord.lavalink_process as lp

    adapter = NS(connect=AsyncMock(side_effect=[0, 1]), reset_preflight=Mock())
    service = NS(adapter=adapter)
    ensure = Mock(return_value=(True, "started"))
    monkeypatch.setattr(lp, "ensure_managed_lavalink", ensure)

    result = asyncio.run(_connect_music_service(NS(config={}), service, object()))
    assert result == 1
    assert adapter.connect.await_count == 2
    adapter.reset_preflight.assert_called_once()
    assert ensure.call_args.kwargs["max_wait_s"] == 25.0


def test_music_recovery_stops_after_failed_restart(monkeypatch):
    import modules.discord.lavalink_process as lp

    adapter = NS(connect=AsyncMock(return_value=0), reset_preflight=Mock())
    service = NS(adapter=adapter)
    monkeypatch.setattr(lp, "ensure_managed_lavalink", Mock(return_value=(False, "no jar")))

    result = asyncio.run(_connect_music_service(NS(config={}), service, object()))
    assert result == 0
    assert adapter.connect.await_count == 1
    adapter.reset_preflight.assert_not_called()


def test_music_recovery_survives_exception_without_leaking_it(monkeypatch):
    import modules.discord.lavalink_process as lp

    adapter = NS(connect=AsyncMock(return_value=0), reset_preflight=Mock())
    service = NS(adapter=adapter)
    monkeypatch.setattr(lp, "ensure_managed_lavalink", Mock(side_effect=RuntimeError("secret")))

    result = asyncio.run(_connect_music_service(NS(config={}), service, object()))
    assert result == 0
    assert adapter.connect.await_count == 1


def test_health_run_once_does_not_block_event_loop(tmp_path, monkeypatch):
    import time

    monitor = HealthMonitor(
        {"health_monitor": {"status_log": str(tmp_path / "health.jsonl")}},
        project_root=tmp_path,
    )
    monkeypatch.setattr(monitor, "_check_backend", AsyncMock(return_value={"ok": True}))
    monkeypatch.setattr(monitor, "_check_storage", Mock(return_value={"ok": True}))
    monkeypatch.setattr(monitor, "_check_and_heal_modules", AsyncMock(return_value={"ok": True}))
    monkeypatch.setattr(monitor, "_check_integrations", Mock(side_effect=lambda: time.sleep(0.2) or {"ok": True}))

    async def scenario():
        ticks = 0

        async def ticker():
            nonlocal ticks
            while True:
                ticks += 1
                await asyncio.sleep(0.01)

        task = asyncio.create_task(ticker())
        await monitor.run_once()
        task.cancel()
        return ticks

    assert asyncio.run(scenario()) >= 5
