"""Offline regression for SoundCloud AAC-HLS source and Lavalink health."""
from __future__ import annotations

from core.runtime.health import check_lavalink
from modules.discord.lavalink_process import _ensure_soundy_yaml, _force_safe_lavalink_log_levels
from modules.discord.music import _normalize_play_query


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
